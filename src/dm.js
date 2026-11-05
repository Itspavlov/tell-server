'use strict';
// ============================================
// Личные сообщения между двумя аккаунтами.
// Диалог = (гость, имя владельца объявления). Читать и писать в нём
// могут только два участника; проверка идёт на сервере по аккаунту.
// Только текст. Хранилище — файл dms.json.
// ============================================
const crypto = require('crypto');
const path = require('path');
const { JsonFile } = require('./jsonfile');
const { normalizeName, normalizeText, fail, CLIENT_ID_RE } = require('./validate');
const { nameKey } = require('./accounts');

const CONV_CAP = 500;

class DmStore {
    constructor({ dataDir, accounts, limits, media = null, now = Date.now, logger = console, fsImpl }) {
        this.media = media;
        this.file = new JsonFile({ file: path.join(dataDir, 'dms.json'), fsImpl });
        this.accounts = accounts;
        this.limits = limits;
        this.now = now;
        this.logger = logger;
        this.data = { convs: {} };
        this.pair = new Map();
        this.recent = new Map();
    }

    async init() {
        const d = await this.file.load({ convs: {} });
        this.data = { convs: d.convs || {} };
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

    _summary(user, c) {
        const iAmGuest = c.guestId === user.id;
        const other = iAmGuest ? c.ownerName : (this.accounts.byId(c.guestId) || { name: 'Гость' }).name;
        const vis = this._visible(user, c);
        const last = vis[vis.length - 1];
        return {
            id: c.id, with: other, adTitle: c.adTitle || '', adId: c.adId || '',
            last: last ? { text: last.video ? 'Видеосообщение' : (last.voice ? 'Голосовое сообщение' : last.text.slice(0, 80)), video: !!last.video, voice: !!last.voice, time: last.time, mine: last.from === user.id } : null,
            updated: c.updated
        };
    }

    _view(c, m) {
        const u = this.accounts.byId(m.from);
        return { id: m.id, convId: c.id, from: { id: m.from, name: u ? u.name : 'Гость' }, text: m.text, time: m.time, ...(m.video ? { video: m.video } : {}), ...(m.voice ? { voice: m.voice } : {}) };
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

    // Возвращает { ok, message, recipients: [id аккаунтов] }
    async send(user, convId, rawText, clientId = null, rawVideo = null, rawVoice = null) {
        const c = this._get(user, convId);
        if (!c) return fail('NO_CONVERSATION');
        if (rawVideo && rawVoice) return fail('BAD_PAYLOAD');
        let video = null, voice = null;
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
        if (!t.value && !video && !voice) return fail('EMPTY_MESSAGE');
        if (clientId !== null && (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId))) return fail('BAD_PAYLOAD');

        const owner = this.accounts.findByKey(c.ownerKey);
        const recipients = [c.guestId, owner && owner.id].filter(Boolean);

        const rk = clientId ? `${user.id}|${convId}|${clientId}` : null;
        if (rk && this.recent.has(rk)) return { ok: true, message: this.recent.get(rk), recipients, duplicate: true };

        const m = { id: 'dmm_' + this.now() + '_' + crypto.randomBytes(5).toString('hex'), from: user.id, text: t.value, time: this.now(), ...(video ? { video } : {}), ...(voice ? { voice } : {}) };
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
