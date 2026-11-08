'use strict';
// ============================================
// Личные сообщения между двумя аккаунтами.
// Диалог = пара аккаунтов (гость и владелец объявления; в обе стороны это один диалог). Читать и писать в нём
// могут только два участника; проверка идёт на сервере по аккаунту.
// Только текст. Хранилище — файл dms.json.
// ============================================
const crypto = require('crypto');
const path = require('path');
const { JsonFile } = require('./jsonfile');
const { normalizeName, normalizeText, fail, CLIENT_ID_RE } = require('./validate');
const { nameKey } = require('./accounts');

const CONV_CAP = 500;
const BLOCK_CAP = 200, REPORT_CAP = 500, REPORT_REASONS = ['spam', 'scam', 'abuse', 'other'];
const DAY = 86400000;

class DmStore {
    constructor({ dataDir, accounts, limits, media = null, now = Date.now, logger = console, fsImpl }) {
        this.media = media;
        this.file = new JsonFile({ file: path.join(dataDir, 'dms.json'), fsImpl });
        this.accounts = accounts;
        this.limits = limits;
        this.now = now;
        this.logger = logger;
        this.data = { convs: {}, blocks: {}, reports: [] };
        this.pair = new Map();
        this.recent = new Map();
    }

    async init() {
        const d = await this.file.load({ convs: {} });
        this.data = { convs: d.convs || {}, blocks: d.blocks || {}, reports: d.reports || [] };
        for (const c of Object.values(this.data.convs)) this.pair.set(c.guestId + '|' + c.ownerKey, c.id);
        this.logger.info?.(`Личные диалоги: ${this.pair.size}`);
    }

    _isParticipant(user, c) { return c.guestId === user.id || c.ownerKey === user.key; }
    _get(user, convId) {
        const c = typeof convId === 'string' ? this.data.convs[convId] : null;
        return c && this._isParticipant(user, c) ? c : null;
    }

    // сообщения, которые пользователь ещё не «удалял у себя»
    _visible(user, c) {
        const cut = (c.hidden && c.hidden[user.id]) || 0;
        return cut ? c.messages.filter(m => m.time > cut) : c.messages;
    }

    _otherId(user, c) {
        if (c.guestId === user.id) { const o = this.accounts.findByKey(c.ownerKey); return o ? o.id : null; }
        return c.guestId;
    }
    _blocked(byId, id) { return !!(byId && id && (this.data.blocks[byId] || []).includes(id)); }

    _summary(user, c) {
        const iAmGuest = c.guestId === user.id;
        const otherId = this._otherId(user, c);
        const myRead = (c.reads && c.reads[user.id]) || 0;
        const other = iAmGuest ? c.ownerName : (this.accounts.byId(c.guestId) || { name: 'Гость' }).name;
        const vis = this._visible(user, c);
        const last = vis[vis.length - 1];
        return {
            id: c.id, with: other, adTitle: c.adTitle || '', adId: c.adId || '',
            last: last ? { text: last.video ? 'Видеосообщение' : (last.voice ? 'Голосовое сообщение' : (last.photo && !last.text ? 'Фото' : last.text.slice(0, 80))), video: !!last.video, voice: !!last.voice, time: last.time, mine: last.from === user.id } : null,
            updated: c.updated,
            unread: vis.filter(m => m.from !== user.id && m.time > myRead).length,
            peerRead: (otherId && c.reads && c.reads[otherId]) || 0,
            blockedByMe: this._blocked(user.id, otherId)
        };
    }

    _view(c, m) {
        const u = this.accounts.byId(m.from);
        return { id: m.id, convId: c.id, from: { id: m.from, name: u ? u.name : 'Гость' }, text: m.text, time: m.time, ...(m.video ? { video: m.video } : {}), ...(m.voice ? { voice: m.voice } : {}), ...(m.photo ? { photo: m.photo } : {}) };
    }

    // Найти или создать диалог гостя с владельцем объявления
    async open(user, rawOwnerName, ad = {}) {
        const n = normalizeName(rawOwnerName, this.limits);
        if (!n.ok) return n;
        const ownerKey = nameKey(n.value);
        if (ownerKey === user.key) return fail('SELF_DM');

        const t = normalizeText(typeof ad.title === 'string' ? ad.title : '', 120);
        const adTitle = t.ok ? t.value : '';
        const adId = typeof ad.id === 'string' && /^[\w-]{1,40}$/.test(ad.id) ? ad.id : '';

        const pairKey = user.id + '|' + ownerKey;
        let c = this.data.convs[this.pair.get(pairKey)];
        // один диалог на пару аккаунтов: если собеседник уже писал вам первым, продолжаем тот же диалог
        if (!c) { const peer = this.accounts.findByKey(ownerKey); if (peer) c = this.data.convs[this.pair.get(peer.id + '|' + user.key)]; }
        let created = false;
        if (!c) {
            c = { id: 'dm_' + crypto.randomBytes(8).toString('hex'), guestId: user.id, ownerKey, ownerName: n.value, adId, adTitle, created: this.now(), updated: this.now(), messages: [] };
            this.data.convs[c.id] = c;
            this.pair.set(pairKey, c.id);
            created = true;
        } else if (adTitle) { c.adId = adId; c.adTitle = adTitle; }
        try { await this.file.save(this.data); }
        catch (e) {
            if (created) { delete this.data.convs[c.id]; this.pair.delete(pairKey); }
            return fail('STORE_UNAVAILABLE');
        }
        return { ok: true, conv: this._summary(user, c), created };
    }

    // Хозяин сменил имя: диалоги привязаны к ключу его имени, переносим их на новый
    async renameOwner(oldKey, newKey, newName) {
        if (!oldKey || !newKey) return 0;
        let n = 0;
        for (const c of Object.values(this.data.convs)) {
            if (c.ownerKey !== oldKey) continue;
            this.pair.delete(c.guestId + '|' + c.ownerKey);
            c.ownerKey = newKey; c.ownerName = newName;
            this.pair.set(c.guestId + '|' + newKey, c.id);
            n++;
        }
        if (n) { try { await this.file.save(this.data); } catch (e) { this.logger.error?.(`dm rename: ${e.code || e.message}`); } }
        return n;
    }

    // Писал ли пользователь хозяину (по ключу имени) хотя бы одно сообщение
    hasWritten(userId, ownerKey) {
        const c = this.data.convs[this.pair.get(userId + '|' + ownerKey)];
        return !!(c && c.messages.some(m => m.from === userId));
    }

    list(user) {
        return Object.values(this.data.convs)
            .filter(c => this._isParticipant(user, c))
            .filter(c => !(c.hidden && c.hidden[user.id]) || this._visible(user, c).length > 0)
            .map(c => this._summary(user, c))
            .sort((a, b) => b.updated - a.updated);
    }

    history(user, convId, { limit = 100, before = null } = {}) {
        const c = this._get(user, convId);
        if (!c) return fail('NO_CONVERSATION');
        const vis = this._visible(user, c);
        let end = vis.length;
        if (before) { const i = vis.findIndex(m => m.id === before); end = i >= 0 ? i : 0; }
        const start = Math.max(0, end - Math.min(limit, 200));
        return { ok: true, conv: this._summary(user, c), messages: vis.slice(start, end).map(m => this._view(c, m)), hasMore: start > 0 };
    }

    // «Удалить у себя»: собеседник свою копию переписки сохраняет
    async remove(user, convId) {
        const c = this._get(user, convId);
        if (!c) return fail('NO_CONVERSATION');
        const prev = c.hidden ? { ...c.hidden } : null;
        c.hidden = { ...(c.hidden || {}), [user.id]: this.now() };
        try { await this.file.save(this.data); }
        catch (e) { c.hidden = prev || undefined; return fail('STORE_UNAVAILABLE'); }
        return { ok: true };
    }

    // Отметить диалог прочитанным: собеседник увидит две галочки
    async markRead(user, convId) {
        const c = this._get(user, convId);
        if (!c) return fail('NO_CONVERSATION');
        const mine = (c.reads && c.reads[user.id]) || 0;
        const newest = this._visible(user, c).filter(m => m.from !== user.id).reduce((a, m) => Math.max(a, m.time), 0);
        const otherId = this._otherId(user, c);
        if (!newest || newest <= mine) return { ok: true, changed: false, time: mine, otherId };
        const prev = c.reads ? { ...c.reads } : null;
        c.reads = { ...(c.reads || {}), [user.id]: this.now() };
        try { await this.file.save(this.data); }
        catch (e) { c.reads = prev || undefined; return fail('STORE_UNAVAILABLE'); }
        return { ok: true, changed: true, time: c.reads[user.id], otherId };
    }

    // Чёрный список: заблокированный не может писать, а вы ему — пока не разблокируете
    async block(user, convId, on) {
        const c = this._get(user, convId);
        if (!c) return fail('NO_CONVERSATION');
        const otherId = this._otherId(user, c);
        if (!otherId) return fail('NO_CONVERSATION');
        const prev = this.data.blocks[user.id] ? [...this.data.blocks[user.id]] : null;
        const list = new Set(prev || []);
        if (on) { if (!list.has(otherId) && list.size >= BLOCK_CAP) return fail('TOO_MANY_BLOCKS'); list.add(otherId); } else list.delete(otherId);
        if (list.size) this.data.blocks[user.id] = [...list]; else delete this.data.blocks[user.id];
        try { await this.file.save(this.data); }
        catch (e) { if (prev) this.data.blocks[user.id] = prev; else delete this.data.blocks[user.id]; return fail('STORE_UNAVAILABLE'); }
        return { ok: true, blockedByMe: !!on };
    }

    // Жалоба: модератор увидит последние сообщения диалога
    async report(user, convId, rawReason, rawText) {
        const c = this._get(user, convId);
        if (!c) return fail('NO_CONVERSATION');
        if (!REPORT_REASONS.includes(rawReason)) return fail('BAD_REASON');
        const t = normalizeText(typeof rawText === 'string' ? rawText : '', 300);
        const otherId = this._otherId(user, c);
        const now = this.now();
        if (this.data.reports.some(r => r.reporterId === user.id && r.convId === c.id && now - r.time < DAY)) return fail('REPORT_DUPLICATE');
        const last = c.messages.slice(-10).map(m => ({ from: m.from === user.id ? 'reporter' : 'other', text: m.video ? '[видео]' : (m.voice ? '[голосовое]' : (m.photo ? '[фото] ' + m.text.slice(0, 280) : m.text.slice(0, 300))), time: m.time }));
        const rep = { id: 'rp_' + crypto.randomBytes(6).toString('hex'), time: now, status: 'open', convId: c.id, reporterId: user.id, targetId: otherId, reason: rawReason, text: t.ok ? t.value : '', messages: last };
        this.data.reports.push(rep);
        const dropped = [];
        while (this.data.reports.length > REPORT_CAP) dropped.push(this.data.reports.shift());
        try { await this.file.save(this.data); }
        catch (e) { const i = this.data.reports.indexOf(rep); if (i >= 0) this.data.reports.splice(i, 1); this.data.reports.unshift(...dropped); return fail('STORE_UNAVAILABLE'); }
        return { ok: true, id: rep.id };
    }

    // Для панели модератора
    reportsList({ status = 'open', limit = 100 } = {}) {
        const name = (id) => { const u = id ? this.accounts.byId(id) : null; return u ? u.name : 'удалён'; };
        return this.data.reports.filter(r => status === 'all' || r.status === status).slice(-limit).reverse()
            .map(r => ({ id: r.id, time: r.time, status: r.status, reason: r.reason, text: r.text, reporter: name(r.reporterId), target: name(r.targetId), messages: r.messages }));
    }
    async closeReport(id) {
        const r = this.data.reports.find(x => x.id === id);
        if (!r) return fail('REPORT_NOT_FOUND');
        const prev = r.status; r.status = 'closed';
        try { await this.file.save(this.data); } catch (e) { r.status = prev; return fail('STORE_UNAVAILABLE'); }
        return { ok: true };
    }

    // Возвращает { ok, message, recipients: [id аккаунтов] }
    async send(user, convId, rawText, clientId = null, rawVideo = null, rawVoice = null, rawPhoto = null) {
        const c = this._get(user, convId);
        if (!c) return fail('NO_CONVERSATION');
        if ((rawVideo ? 1 : 0) + (rawVoice ? 1 : 0) + (rawPhoto ? 1 : 0) > 1) return fail('BAD_PAYLOAD');
        let video = null, voice = null, photo = null;
        if (rawPhoto) {
            const chk = this.media && typeof rawPhoto === 'object' ? this.media.check(rawPhoto.id, user.id, 'photo') : { ok: false };
            if (!chk.ok) return fail('BAD_PAYLOAD');
            photo = { id: rawPhoto.id };
        }
        if (rawVideo) {
            const chk = this.media && typeof rawVideo === 'object' ? this.media.check(rawVideo.id, user.id, 'video') : { ok: false };
            if (!chk.ok) return fail('BAD_PAYLOAD');
            video = { id: rawVideo.id, dur: chk.dur };
        }
        if (rawVoice) {
            const chk = this.media && typeof rawVoice === 'object' ? this.media.check(rawVoice.id, user.id, 'voice') : { ok: false };
            if (!chk.ok) return fail('BAD_PAYLOAD');
            voice = { id: rawVoice.id, dur: chk.dur };
        }
        const t = normalizeText(rawText || '', this.limits.textMax);
        if (!t.ok) return t;
        if (!t.value && !video && !voice && !photo) return fail('EMPTY_MESSAGE');
        if (clientId !== null && (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId))) return fail('BAD_PAYLOAD');

        const otherId = this._otherId(user, c);
        if (this._blocked(user.id, otherId)) return fail('BLOCKED_BY_ME');
        if (this._blocked(otherId, user.id)) return fail('DM_BLOCKED');
        const owner = this.accounts.findByKey(c.ownerKey);
        const recipients = [c.guestId, owner && owner.id].filter(Boolean);

        const rk = clientId ? `${user.id}|${convId}|${clientId}` : null;
        if (rk && this.recent.has(rk)) return { ok: true, message: this.recent.get(rk), recipients, duplicate: true };

        const m = { id: 'dmm_' + this.now() + '_' + crypto.randomBytes(5).toString('hex'), from: user.id, text: t.value, time: this.now(), ...(video ? { video } : {}), ...(voice ? { voice } : {}), ...(photo ? { photo } : {}) };
        c.messages.push(m);
        const dropped = [];
        while (c.messages.length > CONV_CAP) dropped.push(c.messages.shift());
        const prevUpdated = c.updated;
        c.updated = m.time;
        try { await this.file.save(this.data); }
        catch (e) {
            const i = c.messages.lastIndexOf(m); if (i >= 0) c.messages.splice(i, 1);
            c.messages.unshift(...dropped); c.updated = prevUpdated;
            return fail('STORE_UNAVAILABLE');
        }
        const view = this._view(c, m);
        if (rk) { this.recent.set(rk, view); if (this.recent.size > 2000) this.recent.delete(this.recent.keys().next().value); }
        return { ok: true, message: view, recipients };
    }
}

module.exports = { DmStore };
