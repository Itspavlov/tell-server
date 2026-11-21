'use strict';
// ============================================
// Приглашения друзей и дневные лимиты публикаций.
//
// Лимит новых карточек в день считается отдельно по четырём разделам: жильё, работа, поездки, развлечения.
// База — одна карточка в день на раздел. За каждого друга, который зарегистрировался по вашей ссылке
// и опубликовал любую карточку, лимит растёт на единицу, но не выше 5 в день на раздел.
// Засчитываются не больше 5 друзей. Правка и «опубликовать заново» лимит не тратят, удаление его не возвращает.
// Хранилище — файл invites.json.
// ============================================
const crypto = require('crypto');
const path = require('path');
const { JsonFile } = require('./jsonfile');
const { dayKey } = require('./listings');

const SECTIONS = ['housing', 'work', 'trips', 'services'];
const BASE_LIMIT = 1;
const NEWBIE_TOTAL = 2;     // карточек за первые сутки жизни аккаунта, во всех разделах
const DAY_MS = 24 * 3600 * 1000;
const DAY_CAP = 5;          // максимум карточек в день на раздел
const MAX_FRIENDS = 5;      // сколько друзей засчитывается
const PACE_SEC = 3 * 3600;  // интервал между карточками проверенного автора в одном разделе
const MAX_PENDING = 30;     // сколько регистраций по одной ссылке храним (чтобы список не раздувался)
const CODE_RE = /^[A-Z2-9]{6,10}$/;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
    const b = crypto.randomBytes(7);
    let s = '';
    for (let i = 0; i < 7; i++) s += ALPHABET[b[i] % ALPHABET.length];
    return s;
}

class InviteStore {
    constructor({ dataDir, accounts, limits, now = Date.now, logger = console, fsImpl }) {
        this.file = new JsonFile({ file: path.join(dataDir, 'invites.json'), fsImpl });
        this.accounts = accounts;
        this.limits = limits;
        this.now = now;
        this.logger = logger;
        this.data = { codes: {}, refs: {}, usage: {}, last: {} };
        this.byCode = new Map();
    }

    async init() {
        const d = await this.file.load({});
        this.data = { codes: d.codes || {}, refs: d.refs || {}, usage: d.usage || {}, last: d.last || {} };
        for (const [uid, code] of Object.entries(this.data.codes)) this.byCode.set(code, uid);
    }

    async flush() {
        try { await this.file.save(this.data); return true; }
        catch (e) { this.logger.error?.(`invites: ${e.code || e.message}`); return false; }
    }

    // ---- код приглашения ----
    async ensureCode(userId) {
        let code = this.data.codes[userId];
        if (code) return code;
        do { code = newCode(); } while (this.byCode.has(code));
        this.data.codes[userId] = code;
        this.byCode.set(code, userId);
        if (!(await this.flush())) { delete this.data.codes[userId]; this.byCode.delete(code); return null; }
        return code;
    }

    resolve(rawCode) {
        const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
        return CODE_RE.test(code) ? (this.byCode.get(code) || null) : null;
    }

    // ---- друзья ----
    // Привязка нового аккаунта к тому, кто его пригласил. Один раз и только пока друг не опубликовал карточку.
    async attach(friendId, rawCode) {
        const inviter = this.resolve(rawCode);
        if (!inviter || inviter === friendId) return false;
        if (this.data.refs[friendId]) return false;
        if (this._of(inviter).length >= MAX_PENDING) return false;
        this.data.refs[friendId] = { by: inviter, at: this.now(), done: 0 };
        if (!(await this.flush())) { delete this.data.refs[friendId]; return false; }
        return true;
    }

    // Друг опубликовал карточку. Возвращает { inviterId, counted } при первом засчёте, иначе null.
    async qualify(friendId) {
        const r = this.data.refs[friendId];
        if (!r || r.done) return null;
        r.done = this.now();
        const counted = this._doneOf(r.by).findIndex(x => x.id === friendId) < MAX_FRIENDS;
        if (!(await this.flush())) { r.done = 0; return null; }
        return { inviterId: r.by, counted };
    }

    _of(inviterId) {
        return Object.entries(this.data.refs).filter(([, r]) => r.by === inviterId).map(([id, r]) => ({ id, ...r }));
    }
    _doneOf(inviterId) { return this._of(inviterId).filter(x => x.done).sort((a, b) => a.done - b.done); }

    // Сколько друзей засчитано (не больше MAX_FRIENDS)
    bonus(userId) { return Math.min(MAX_FRIENDS, this._doneOf(userId).length); }

    friendsOf(userId) {
        const done = this._doneOf(userId).slice(0, MAX_FRIENDS).map(x => x.id);
        return this._of(userId).sort((a, b) => a.at - b.at).map(x => {
            const u = this.accounts && this.accounts.byId(x.id);
            return { name: u ? u.name : 'Друг', done: !!x.done, counted: done.includes(x.id) };
        });
    }

    // ---- лимиты по разделам ----
    limitFor(userId) { return Math.min(DAY_CAP, BASE_LIMIT + this.bonus(userId)); }

    _day() { return dayKey(this.now(), this.limits.serviceTz); }

    quota(userId, section) {
        const sec = SECTIONS.includes(section) ? section : 'housing';
        const day = this._day();
        const u = this.data.usage[userId];
        const used = u && u.day === day ? (u[sec] || 0) : 0;
        const limit = this.limitFor(userId);
        return { section: sec, used, limit, left: Math.max(0, limit - used), day };
    }

    allQuotas(userId) {
        const out = {};
        for (const s of SECTIONS) out[s] = this.quota(userId, s);
        return out;
    }

    // Проверка и учёт идут синхронно (до первого await), поэтому параллельные запросы не пробьют лимит.
    // undo() возвращает счётчик, если публикация потом не удалась.
    // Новый аккаунт (младше суток) в первые сутки публикует не больше NEWBIE_TOTAL карточек во всех разделах вместе
    _isNewbie(userId) {
        const u = this.accounts && this.accounts.data && this.accounts.data.users && this.accounts.data.users[userId];
        return !!(u && u.createdAt && this.now() - u.createdAt < DAY_MS);
    }
    _usedToday(userId) {
        const u = this.data.usage[userId];
        if (!u || u.day !== this._day()) return 0;
        return SECTIONS.reduce((n, s) => n + (u[s] || 0), 0);
    }

    // Проверенный автор: суточный лимит заменён интервалом. Первая карточка сразу, каждая следующая в разделе не раньше чем через
    // PACE_SEC (по умолчанию 3 часа), всего не больше DAY_CAP в день. Непроверенные идут через модерацию и обычный дневной лимит.
    reserve(userId, section, { verified = false, pace = true } = {}) {
        const q0 = this.quota(userId, section);
        const q = verified ? { ...q0, limit: DAY_CAP, left: Math.max(0, DAY_CAP - q0.used), verified: true } : q0;
        if (q.left <= 0) return { ok: false, quota: q };
        if (this._isNewbie(userId) && this._usedToday(userId) >= NEWBIE_TOTAL) return { ok: false, quota: { ...q, left: 0, newbie: true } };
        const gap = (this.limits.verifiedGapSec != null ? this.limits.verifiedGapSec : PACE_SEC) * 1000;
        const lastAt = verified && this.data.last[userId] ? (this.data.last[userId][q.section] || 0) : 0;
        if (verified && pace && gap > 0 && lastAt && this.now() - lastAt < gap) {
            return { ok: false, wait: Math.ceil((lastAt + gap - this.now()) / 1000), quota: q };
        }
        const prev = this.data.usage[userId] ? { ...this.data.usage[userId] } : undefined;
        const prevLast = this.data.last[userId] ? { ...this.data.last[userId] } : undefined;
        const cur = prev && prev.day === q.day ? { ...prev } : { day: q.day };
        cur[q.section] = (cur[q.section] || 0) + 1;
        this.data.usage[userId] = cur;
        if (verified && pace) this.data.last[userId] = { ...(prevLast || {}), [q.section]: this.now() };
        let undone = false;
        return {
            ok: true,
            quota: { ...q, used: q.used + 1, left: q.left - 1 },
            undo: () => {
                if (undone) return; undone = true;
                if (prev === undefined) delete this.data.usage[userId]; else this.data.usage[userId] = prev;
                if (verified && pace) { if (prevLast === undefined) delete this.data.last[userId]; else this.data.last[userId] = prevLast; }
            }
        };
    }

    // Чистим счётчики прошлых дней
    sweep() {
        const day = this._day();
        for (const [uid, u] of Object.entries(this.data.usage)) if (u.day !== day) delete this.data.usage[uid];
    }
}

// Код приглашения и счётчики пользователя удаляются; записи друзей остаются (бонус уже выдан или не выдавался)
InviteStore.prototype.eraseUser = async function (userId) {
    const code = this.data.codes[userId], usage = this.data.usage[userId], ref = this.data.refs[userId];
    if (code === undefined && usage === undefined && ref === undefined) return 0;
    delete this.data.codes[userId]; delete this.data.usage[userId]; delete this.data.refs[userId];
    if (code) this.byCode.delete(code);
    if (!(await this.flush())) {
        if (code !== undefined) { this.data.codes[userId] = code; this.byCode.set(code, userId); }
        if (usage !== undefined) this.data.usage[userId] = usage;
        if (ref !== undefined) this.data.refs[userId] = ref;
        throw new Error('STORE_UNAVAILABLE');
    }
    return 1;
};

module.exports = { InviteStore, SECTIONS, BASE_LIMIT, DAY_CAP, MAX_FRIENDS };
