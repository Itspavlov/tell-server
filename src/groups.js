'use strict';
// ============================================
// Группы друзей («Моя группа») и реакции на объявления.
//
// Группа: название, владелец, участники (аккаунты), код-приглашение.
// В группе: сообщения с ответами и реакциями, а также карточки объявлений.
// Читать и писать могут только участники (проверка на сервере).
// Хранилище — файлы groups.json и adreactions.json.
// ============================================
const crypto = require('crypto');
const path = require('path');
const { JsonFile } = require('./jsonfile');
const { normalizeName, normalizeText, fail, CLIENT_ID_RE, REACTIONS, MSG_ID_RE } = require('./validate');
const { nameKey } = require('./accounts');

const GROUP_MSG_CAP = 500;
const MAX_MEMBERS = 20;
const MAX_GROUPS_PER_USER = 10;
const AD_ID_RE = /^[\w-]{1,40}$/;
const MAX_AD_IDS = 3000;

function cleanAd(ad) {
    if (!ad || typeof ad !== 'object' || typeof ad.id !== 'string' || !AD_ID_RE.test(ad.id)) return null;
    const t = (v, max) => { const r = normalizeText(typeof v === 'string' ? v : '', max); return r.ok ? r.value : ''; };
    const title = t(ad.title, 120);
    if (!title) return null;
    return { id: ad.id, title, price: t(ad.price, 40), location: t(ad.location, 80) };
}

class GroupStore {
    constructor({ dataDir, accounts, limits, media = null, now = Date.now, logger = console, fsImpl }) {
        this.media = media;
        this.file = new JsonFile({ file: path.join(dataDir, 'groups.json'), fsImpl });
        this.accounts = accounts;
        this.limits = limits;
        this.now = now;
        this.logger = logger;
        this.data = { groups: {} };
        this.byCode = new Map();
        this.recent = new Map();
    }

    async init() {
        const d = await this.file.load({ groups: {} });
        this.data = { groups: d.groups || {} };
        for (const g of Object.values(this.data.groups)) this.byCode.set(g.code, g.id);
        this.logger.info?.(`Группы: ${Object.keys(this.data.groups).length}`);
    }

    _get(user, id) {
        const g = typeof id === 'string' ? this.data.groups[id] : null;
        return g && g.members.includes(user.id) ? g : null;
    }

    _persist(undo) {
        return this.file.save(this.data).catch((e) => { if (undo) undo(); this.logger.error?.(`groups: ${e.code || e.message}`); throw e; });
    }

    _memberViews(g) {
        return g.members.map(id => { const u = this.accounts.byId(id); return { id, name: u ? u.name : 'Гость' }; });
    }

    _summary(user, g) {
        const last = g.messages[g.messages.length - 1];
        return {
            id: g.id, name: g.name, members: g.members.length, isOwner: g.ownerId === user.id,
            last: last ? { text: last.ad ? '🏠 ' + last.ad.title : (last.video ? 'Видеосообщение' : (last.voice ? 'Голосовое сообщение' : last.text.slice(0, 80))), time: last.time, from: (this.accounts.byId(last.from) || { name: '' }).name } : null,
            updated: g.updated
        };
    }

    view(m, viewerId = null) {
        const u = this.accounts.byId(m.from);
        const reactions = {}; const mine = [];
        for (const e of REACTIONS) {
            const arr = m.reactions && m.reactions[e];
            if (Array.isArray(arr) && arr.length) { reactions[e] = arr.length; if (viewerId && arr.includes(viewerId)) mine.push(e); }
        }
        return {
            id: m.id, groupId: m.groupId, from: { id: m.from, name: u ? u.name : 'Гость' },
            text: m.text, time: m.time, reply: m.reply || null, ad: m.ad || null, reactions, mine,
            ...(m.video ? { video: m.video } : {}), ...(m.voice ? { voice: m.voice } : {})
        };
    }

    async create(user, rawName) {
        const t = normalizeText(typeof rawName === 'string' ? rawName : '', 40);
        if (!t.ok || t.value.length < 2) return fail('BAD_GROUP_NAME');
        const mineCount = Object.values(this.data.groups).filter(g => g.members.includes(user.id)).length;
        if (mineCount >= MAX_GROUPS_PER_USER) return fail('TOO_MANY_GROUPS');
        const g = {
            id: 'g_' + crypto.randomBytes(8).toString('hex'), name: t.value, ownerId: user.id,
            members: [user.id], code: crypto.randomBytes(8).toString('hex'),
            created: this.now(), updated: this.now(), messages: []
        };
        this.data.groups[g.id] = g; this.byCode.set(g.code, g.id);
        try { await this._persist(() => { delete this.data.groups[g.id]; this.byCode.delete(g.code); }); }
        catch (e) { return fail('STORE_UNAVAILABLE'); }
        return { ok: true, group: this._detail(user, g) };
    }

    _detail(user, g) {
        return { id: g.id, name: g.name, isOwner: g.ownerId === user.id, code: g.code, members: this._memberViews(g).map(m => ({ ...m, owner: m.id === g.ownerId })) };
    }

    list(user) {
        return Object.values(this.data.groups).filter(g => g.members.includes(user.id))
            .map(g => this._summary(user, g)).sort((a, b) => b.updated - a.updated);
    }

    open(user, id, { before = null, limit = 100 } = {}) {
        const g = this._get(user, id);
        if (!g) return fail('NO_GROUP');
        let end = g.messages.length;
        if (before) { const i = g.messages.findIndex(m => m.id === before); end = i >= 0 ? i : 0; }
        const start = Math.max(0, end - Math.min(limit, 200));
        return { ok: true, group: this._detail(user, g), messages: g.messages.slice(start, end).map(m => this.view(m, user.id)), hasMore: start > 0 };
    }

    memberIds(id) { const g = this.data.groups[id]; return g ? [...g.members] : []; }

    async send(user, id, { text, replyTo, ad, clientId, video: rawVideo, voice: rawVoice } = {}) {
        const g = this._get(user, id);
        if (!g) return fail('NO_GROUP');
        let body = '';
        if (text !== undefined && text !== null) {
            const t = normalizeText(text, this.limits.textMax);
            if (!t.ok) return t;
            body = t.value;
        }
        const cardAd = ad ? cleanAd(ad) : null;
        if (ad && !cardAd) return fail('BAD_PAYLOAD');
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
        if (!body && !cardAd && !video && !voice) return fail('EMPTY_MESSAGE');
        if (clientId !== null && clientId !== undefined && (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId))) return fail('BAD_PAYLOAD');

        const rk = clientId ? `${user.id}|${g.id}|${clientId}` : null;
        if (rk && this.recent.has(rk)) return { ok: true, message: this.recent.get(rk), duplicate: true, members: this.memberIds(g.id) };

        const m = { id: 'gm_' + this.now() + '_' + crypto.randomBytes(5).toString('hex'), groupId: g.id, from: user.id, text: body, time: this.now() };
        if (cardAd) m.ad = cardAd;
        if (video) m.video = video;
        if (voice) m.voice = voice;
        if (typeof replyTo === 'string' && /^gm_[\w-]{1,60}$/.test(replyTo)) {
            const src = g.messages.find(x => x.id === replyTo);
            if (src) {
                const su = this.accounts.byId(src.from);
                m.reply = { id: src.id, user: su ? su.name : 'Гость', text: src.text ? src.text.slice(0, 100) : (src.ad ? '🏠 ' + src.ad.title : (src.video ? 'Видеосообщение' : (src.voice ? 'Голосовое сообщение' : ''))) };
            }
        }
        g.messages.push(m);
        const dropped = [];
        while (g.messages.length > GROUP_MSG_CAP) dropped.push(g.messages.shift());
        const prev = g.updated; g.updated = m.time;
        try {
            await this._persist(() => { const i = g.messages.lastIndexOf(m); if (i >= 0) g.messages.splice(i, 1); g.messages.unshift(...dropped); g.updated = prev; });
        } catch (e) { return fail('STORE_UNAVAILABLE'); }
        const v = this.view(m);
        if (rk) { this.recent.set(rk, v); if (this.recent.size > 2000) this.recent.delete(this.recent.keys().next().value); }
        return { ok: true, message: v, members: this.memberIds(g.id) };
    }

    async react(user, id, msgId, emoji) {
        const g = this._get(user, id);
        if (!g) return fail('NO_GROUP');
        if (!REACTIONS.includes(emoji)) return fail('BAD_REACTION');
        const m = typeof msgId === 'string' ? g.messages.find(x => x.id === msgId) : null;
        if (!m) return fail('MESSAGE_NOT_FOUND');
        const prev = JSON.stringify(m.reactions || {});
        if (!m.reactions) m.reactions = {};
        const arr = Array.isArray(m.reactions[emoji]) ? m.reactions[emoji] : (m.reactions[emoji] = []);
        const i = arr.indexOf(user.id);
        if (i >= 0) arr.splice(i, 1); else arr.push(user.id);
        if (!arr.length) delete m.reactions[emoji];
        try { await this._persist(() => { m.reactions = JSON.parse(prev); }); } catch (e) { return fail('STORE_UNAVAILABLE'); }
        const v = this.view(m, user.id);
        return { ok: true, reactions: v.reactions, mine: v.mine, members: this.memberIds(g.id) };
    }

    // Добавить зарегистрированного человека по имени
    async invite(user, id, rawName) {
        const g = this._get(user, id);
        if (!g) return fail('NO_GROUP');
        const n = normalizeName(rawName, this.limits);
        if (!n.ok) return fail('USER_NOT_FOUND');
        const target = this.accounts.findByKey(nameKey(n.value));
        if (!target) return fail('USER_NOT_FOUND');
        return this._addMember(g, target);
    }

    async join(user, code) {
        const id = typeof code === 'string' ? this.byCode.get(code) : null;
        const g = id ? this.data.groups[id] : null;
        if (!g) return fail('BAD_INVITE');
        if (g.members.includes(user.id)) return { ok: true, group: this._detail(user, g), already: true };
        const r = await this._addMember(g, user);
        return r.ok ? { ok: true, group: this._detail(user, g), members: r.members } : r;
    }

    async _addMember(g, target) {
        if (g.members.includes(target.id)) return fail('ALREADY_MEMBER');
        if (g.members.length >= MAX_MEMBERS) return fail('GROUP_FULL');
        const mineCount = Object.values(this.data.groups).filter(x => x.members.includes(target.id)).length;
        if (mineCount >= MAX_GROUPS_PER_USER) return fail('TOO_MANY_GROUPS');
        g.members.push(target.id);
        try { await this._persist(() => { g.members = g.members.filter(x => x !== target.id); }); }
        catch (e) { return fail('STORE_UNAVAILABLE'); }
        return { ok: true, added: { id: target.id, name: target.name }, members: [...g.members], group: { id: g.id, name: g.name } };
    }

    async leave(user, id) {
        const g = this._get(user, id);
        if (!g) return fail('NO_GROUP');
        const before = [...g.members];
        const wasOwner = g.ownerId === user.id;
        g.members = g.members.filter(x => x !== user.id);
        let removed = false;
        const prevOwner = g.ownerId;
        if (!g.members.length) { delete this.data.groups[g.id]; this.byCode.delete(g.code); removed = true; }
        else if (wasOwner) g.ownerId = g.members[0];
        try {
            await this._persist(() => { g.members = before; g.ownerId = prevOwner; if (removed) { this.data.groups[g.id] = g; this.byCode.set(g.code, g.id); } });
        } catch (e) { return fail('STORE_UNAVAILABLE'); }
        return { ok: true, remaining: g.members };
    }
}

// ---------- реакции на объявления ----------
class AdReactions {
    constructor({ dataDir, logger = console, fsImpl }) {
        this.file = new JsonFile({ file: path.join(dataDir, 'adreactions.json'), fsImpl });
        this.logger = logger;
        this.data = { ads: {} };
    }
    async init() { const d = await this.file.load({ ads: {} }); this.data = { ads: d.ads || {} }; }

    view(adId, viewer) {
        const counts = {}; const mine = [];
        const r = this.data.ads[adId] || {};
        for (const e of REACTIONS) if (Array.isArray(r[e]) && r[e].length) { counts[e] = r[e].length; if (viewer && r[e].includes(viewer)) mine.push(e); }
        return { counts, mine };
    }

    many(ids, viewer) {
        const out = {};
        for (const id of ids.slice(0, 50)) if (typeof id === 'string' && AD_ID_RE.test(id)) out[id] = this.view(id, viewer);
        return out;
    }

    async toggle(adId, emoji, voter) {
        if (typeof adId !== 'string' || !AD_ID_RE.test(adId)) return fail('BAD_PAYLOAD');
        if (!REACTIONS.includes(emoji)) return fail('BAD_REACTION');
        if (!this.data.ads[adId] && Object.keys(this.data.ads).length >= MAX_AD_IDS) return fail('STORE_FULL');
        const prev = JSON.stringify(this.data.ads[adId] || null);
        const r = this.data.ads[adId] || (this.data.ads[adId] = {});
        const arr = Array.isArray(r[emoji]) ? r[emoji] : (r[emoji] = []);
        const i = arr.indexOf(voter);
        if (i >= 0) arr.splice(i, 1); else if (arr.length < 200) arr.push(voter);
        if (!arr.length) delete r[emoji];
        if (!Object.keys(r).length) delete this.data.ads[adId];
        try { await this.file.save(this.data); }
        catch (e) { const old = JSON.parse(prev); if (old) this.data.ads[adId] = old; else delete this.data.ads[adId]; return fail('STORE_UNAVAILABLE'); }
        return { ok: true, ...this.view(adId, voter) };
    }
}

module.exports = { GroupStore, AdReactions, cleanAd, AD_ID_RE };
