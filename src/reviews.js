'use strict';
// ============================================
// Отзывы об объявлениях.
//  • отзыв оставляет вошедший пользователь, не хозяин, один на объявление (можно изменить);
//  • чтобы не было накруток, нужно хотя бы раз написать хозяину в личные сообщения
//    (системы бронирования нет, это единственная проверка «контакта»);
//  • хозяин может один раз ответить на отзыв;
//  • автор удаляет свой отзыв, модератор — любой.
// ============================================
const crypto = require('crypto');
const path = require('path');
const { JsonFile } = require('./jsonfile');
const { fail, normalizeText } = require('./validate');

const TEXT_MAX = 600, REPLY_MAX = 400, CAP = 5000;

class ReviewStore {
    constructor({ dataDir, accounts, dms, now = Date.now, logger = console, fsImpl }) {
        this.file = new JsonFile({ file: path.join(dataDir, 'reviews.json'), fsImpl });
        this.accounts = accounts; this.dms = dms; this.now = now; this.logger = logger;
        this.data = { items: {} };
        this.statsL = new Map(); this.statsO = new Map();
    }

    async renameAuthor(userId, name) {
        let n = 0;
        for (const r of Object.values(this.data.items)) if (r.authorId === userId && r.authorName !== name) { r.authorName = name; n++; }
        if (n) { try { await this.file.save(this.data); } catch (e) { this.logger.error?.(`reviews rename: ${e.code || e.message}`); } }
        return n;
    }

    async init() {
        const d = await this.file.load({});
        this.data = { items: d.items || {} };
        this._index();
    }

    _index() {
        const l = new Map(), o = new Map();
        const add = (m, k, r) => { const s = m.get(k) || { sum: 0, n: 0 }; s.sum += r; s.n++; m.set(k, s); };
        for (const v of Object.values(this.data.items)) { add(l, v.listingId, v.rating); add(o, v.ownerId, v.rating); }
        this.statsL = l; this.statsO = o;
    }
    _fmt(s) { return s && s.n ? { rating: Math.round(s.sum / s.n * 10) / 10, count: s.n } : { rating: null, count: 0 }; }
    listingStats(id) { return this._fmt(this.statsL.get(id)); }
    ownerStats(id) { return this._fmt(this.statsO.get(id)); }

    _view(r, viewer) {
        return {
            id: r.id, rating: r.rating, text: r.text, created: r.created, updated: r.updated,
            author: { id: r.authorId, name: r.authorName }, reply: r.reply || null,
            mine: !!(viewer && viewer.id === r.authorId)
        };
    }

    list(listingId, viewer) {
        const items = Object.values(this.data.items).filter(r => r.listingId === listingId).sort((a, b) => b.created - a.created).map(r => this._view(r, viewer));
        return { items, ...this.listingStats(listingId) };
    }

    // Все отзывы на объявления хозяина (для его профиля)
    forOwner(ownerId, viewer, listings) {
        const items = Object.values(this.data.items).filter(r => r.ownerId === ownerId).sort((a, b) => b.created - a.created).slice(0, 100).map(r => {
            const l = listings && listings.rawById(r.listingId);
            return { ...this._view(r, viewer), listingId: r.listingId, listingTitle: l && l.ad ? l.ad.title : '' };
        });
        return { items, ...this.ownerStats(ownerId) };
    }

    // Может ли пользователь писать отзыв: { can, reason, mine }
    status(user, listing) {
        if (!user) return { can: false, reason: 'AUTH_REQUIRED' };
        if (listing.ownerId === user.id) return { can: false, reason: 'SELF_REVIEW' };
        const mine = Object.values(this.data.items).find(r => r.listingId === listing.id && r.authorId === user.id);
        if (mine) return { can: true, mine: this._view(mine, user) };
        if (!this._contacted(user, listing)) return { can: false, reason: 'NEED_CONTACT' };
        return { can: true };
    }

    _contacted(user, listing) {
        const owner = this.accounts.byId(listing.ownerId);
        return !!(owner && this.dms && this.dms.hasWritten(user.id, owner.key));
    }

    async save(user, listing, payload) {
        const p = payload && typeof payload === 'object' ? payload : {};
        const rating = Number(p.rating);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail('BAD_RATING');
        const t = normalizeText(typeof p.text === 'string' ? p.text : '', TEXT_MAX);
        if (!t.ok) return t.code === 'TEXT_TOO_LONG' ? fail('REVIEW_TOO_LONG') : t;
        if (listing.ownerId === user.id) return fail('SELF_REVIEW');
        let r = Object.values(this.data.items).find(x => x.listingId === listing.id && x.authorId === user.id);
        if (!r && !this._contacted(user, listing)) return fail('NEED_CONTACT');
        if (!r && Object.keys(this.data.items).length >= CAP) return fail('STORE_UNAVAILABLE');
        const t0 = this.now();
        const created = !r;
        const prev = r ? { ...r } : null;
        if (created) {
            r = { id: 'rv_' + crypto.randomBytes(6).toString('hex'), listingId: listing.id, ownerId: listing.ownerId, authorId: user.id, authorName: user.name, rating, text: t.value, created: t0, updated: t0 };
            this.data.items[r.id] = r;
        } else { r.rating = rating; r.text = t.value; r.updated = t0; }
        try { await this.file.save(this.data); }
        catch (e) { if (created) delete this.data.items[r.id]; else Object.assign(r, prev); this._index(); return fail('STORE_UNAVAILABLE'); }
        this._index();
        return { ok: true, review: this._view(r, user), created, ...this.listingStats(listing.id) };
    }

    get(id) { return typeof id === 'string' ? this.data.items[id] || null : null; }

    async remove(user, id, { admin = false } = {}) {
        const r = this.get(id);
        if (!r) return fail('REVIEW_NOT_FOUND');
        if (!admin && r.authorId !== user.id) return fail('NOT_AUTHOR');
        delete this.data.items[id];
        try { await this.file.save(this.data); }
        catch (e) { this.data.items[id] = r; return fail('STORE_UNAVAILABLE'); }
        this._index();
        return { ok: true, review: r };
    }

    async reply(user, id, text) {
        const r = this.get(id);
        if (!r) return fail('REVIEW_NOT_FOUND');
        if (r.ownerId !== user.id) return fail('NOT_OWNER');
        const t = normalizeText(typeof text === 'string' ? text : '', REPLY_MAX);
        if (!t.ok) return t.code === 'TEXT_TOO_LONG' ? fail('REPLY_TOO_LONG') : t;
        if (!t.value) return fail('BAD_PAYLOAD');
        if (r.reply) return fail('ALREADY_REPLIED');
        r.reply = { text: t.value, time: this.now() };
        try { await this.file.save(this.data); }
        catch (e) { delete r.reply; return fail('STORE_UNAVAILABLE'); }
        return { ok: true, review: r };
    }

    // Отзывы удалённого объявления не нужны
    async dropListing(listingId) {
        const ids = Object.keys(this.data.items).filter(k => this.data.items[k].listingId === listingId);
        if (!ids.length) return;
        const keep = {}; for (const i of ids) keep[i] = this.data.items[i];
        for (const i of ids) delete this.data.items[i];
        try { await this.file.save(this.data); } catch (e) { Object.assign(this.data.items, keep); }
        this._index();
    }

    listAll(limit = 300) {
        return Object.values(this.data.items).sort((a, b) => b.created - a.created).slice(0, limit).map(r => ({
            id: r.id, listingId: r.listingId, author: r.authorName, rating: r.rating, text: r.text, created: r.created, reply: r.reply ? r.reply.text : ''
        }));
    }
}

module.exports = { ReviewStore };
