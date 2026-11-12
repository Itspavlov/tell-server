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
const DAY_CAP = 5;          // максимум карточек в день на раздел
const MAX_FRIENDS = 5;      // сколько друзей засчитывается
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
        this.data = { codes: {}, refs: {}, usage: {} };
        this.byCode = new Map();
    }

    async init() {
        const d = await this.file.load({});
        this.data = { codes: d.codes || {}, refs: d.refs || {}, usage: d.usage || {} };
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
    reserve(userId, section) {
        const q = this.quota(userId, section);
        if (q.left <= 0) return { ok: false, quota: q };
        const prev = this.data.usage[userId] ? { ...this.data.usage[userId] } : undefined;
        const cur = prev && prev.day === q.day ? { ...prev } : { day: q.day };
        cur[q.section] = (cur[q.section] || 0) + 1;
        this.data.usage[userId] = cur;
        let undone = false;
        return {
            ok: true,
            quota: { ...q, used: q.used + 1, left: q.left - 1 },
            undo: () => {
                if (undone) return; undone = true;
                if (prev === undefined) delete this.data.usage[userId]; else this.data.usage[userId] = prev;
            }
        };
    }

    // Чистим счётчики прошлых дней
    sweep() {
        const day = this._day();
        for (const [uid, u] of Object.entries(this.data.usage)) if (u.day !== day) delete this.data.usage[uid];
    }
}

module.exports = { InviteStore, SECTIONS, BASE_LIMIT, DAY_CAP, MAX_FRIENDS };
