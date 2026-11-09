'use strict';
// ============================================
// «Курортный движ»: карточки «найди компанию» — джипы, морская прогулка, волейбол, просто потусить.
//  • карточку создаёт вошедший пользователь: название, описание, время, место, до 5 фото;
//  • к ней можно закрепить карточку из «Развлечений» (например, морскую прогулку);
//  • под карточкой — комментарии и кнопка «Я с вами» (отклик); автор получает уведомления;
//  • карточка живёт до времени встречи (+6 часов) или 7 дней, если время не указано.
// Хранилище — файл dviz.json (фото проверяются по содержимому, как у объявлений).
// ============================================
const crypto = require('crypto');
const path = require('path');
const { JsonFile } = require('./jsonfile');
const { normalizeText, validateImage, fail } = require('./validate');

const MAX_ACTIVE_PER_USER = 5, MAX_PHOTOS = 5, PHOTO_BYTES = 300_000, THUMB_BYTES = 60_000;
const MAX_BYTES = 120 * 1048576;
const COMMENT_CAP = 200, JOIN_CAP = 200, COMMENT_MAX = 400;
const DAY = 86400000, HOUR = 3600000;
const WHEN_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const whenMs = (w) => { const t = Date.parse(w + ':00+03:00'); return Number.isFinite(t) ? t : NaN; };   // время курорта (МСК)

function cleanDviz(raw, now) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('BAD_REQUEST');
    const t = normalizeText(typeof raw.title === 'string' ? raw.title : '', 80);
    if (!t.ok || !t.value) return fail('DVIZ_TITLE');
    const d = normalizeText(typeof raw.text === 'string' ? raw.text : '', 1000);
    if (!d.ok) return fail('DVIZ_TEXT');
    const p = normalizeText(typeof raw.place === 'string' ? raw.place : '', 120);
    if (!p.ok) return fail('BAD_REQUEST');
    let when = '';
    if (raw.when !== undefined && raw.when !== null && raw.when !== '') {
        if (typeof raw.when !== 'string' || !WHEN_RE.test(raw.when)) return fail('DVIZ_WHEN');
        const ms = whenMs(raw.when);
        if (Number.isNaN(ms) || ms < now - HOUR || ms > now + 180 * DAY) return fail('DVIZ_WHEN');
        when = raw.when;
    }
    let max = 0;
    if (raw.max !== undefined && raw.max !== null && raw.max !== '') {
        max = Number(raw.max);
        if (!Number.isInteger(max) || max < 2 || max > 99) return fail('BAD_REQUEST');
    }
    let coords = null;
    if (raw.coords !== undefined && raw.coords !== null) {
        const c = raw.coords;
        if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== 'number' || typeof c[1] !== 'number'
            || !Number.isFinite(c[0]) || !Number.isFinite(c[1]) || Math.abs(c[0]) > 90 || Math.abs(c[1]) > 180) return fail('BAD_REQUEST');
        coords = [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5];
    }
    const photos = [];
    if (raw.photos !== undefined && !Array.isArray(raw.photos)) return fail('IMAGE_INVALID');
    for (const ph of (raw.photos || []).slice(0, MAX_PHOTOS + 1)) {
        const r = validateImage(ph, PHOTO_BYTES);
        if (!r.ok) return fail('IMAGE_INVALID');
        photos.push(r.value);
    }
    if (photos.length > MAX_PHOTOS) return fail('IMAGE_INVALID');
    let thumb = '';
    if (raw.thumb) { const r = validateImage(raw.thumb, THUMB_BYTES); if (!r.ok) return fail('IMAGE_INVALID'); thumb = r.value; }
    else if (photos[0] && photos[0].length <= Math.ceil(THUMB_BYTES * 4 / 3) + 128) thumb = photos[0];
    return { ok: true, value: { title: t.value, text: d.value, place: p.value, when, max, photos, thumb, ...(coords ? { coords } : {}) } };
}

class DvizStore {
    constructor({ dataDir, accounts, services = null, now = Date.now, logger = console, fsImpl }) {
        this.file = new JsonFile({ file: path.join(dataDir, 'dviz.json'), fsImpl });
        this.accounts = accounts; this.services = services; this.now = now; this.logger = logger;
        this.data = { items: {} };
        this.bytes = 0;
    }

    async init() {
        const d = await this.file.load({});
        this.data = { items: d.items || {} };
        this.bytes = JSON.stringify(this.data).length;
        this.logger.info?.(`Курортный движ: ${Object.keys(this.data.items).length}, ${(this.bytes / 1048576).toFixed(1)} МБ`);
    }

    _expires(e) { const w = e.when ? whenMs(e.when) : NaN; return Number.isNaN(w) ? e.created + 7 * DAY : w + 6 * HOUR; }
    _alive(e) { return this._expires(e) > this.now(); }

    _view(e, viewerId, full) {
        const u = this.accounts.byId(e.ownerId);
        const joined = !!(viewerId && e.joins.some(j => j.userId === viewerId));
        return {
            id: e.id, ownerId: e.ownerId, ownerName: u ? u.name : e.ownerName, verified: !!(u && u.verified),
            created: e.created, title: e.title, text: full ? e.text : e.text.slice(0, 160), place: e.place, coords: e.coords || null, when: e.when, max: e.max,
            thumb: e.thumb || '', photoCount: e.photos.length, attached: e.attached || null,
            comments: e.comments.length, joins: e.joins.length, joined, expires: this._expires(e),
            joinNames: e.joins.slice(0, 3).map(j => (this.accounts.byId(j.userId) || { name: j.name }).name),
            ...(full ? {
                photos: e.photos,
                joinList: e.joins.map(j => ({ userId: j.userId, name: (this.accounts.byId(j.userId) || { name: j.name }).name, time: j.time })),
                commentList: e.comments.map(c => ({ id: c.id, userId: c.userId, name: (this.accounts.byId(c.userId) || { name: c.name }).name, text: c.text, time: c.time }))
            } : {})
        };
    }

    // Лента: сначала ближайшие по времени встречи, без времени — по свежести
    list({ viewerId = null, ownerId = '', limit = 100 } = {}) {
        const t = this.now();
        return Object.values(this.data.items).filter(e => this._alive(e) && (!ownerId || e.ownerId === ownerId))
            .sort((a, b) => b.created - a.created).slice(0, limit).map(e => this._view(e, viewerId, false));
    }
    get(id, viewerId = null) { const e = typeof id === 'string' ? this.data.items[id] : null; return e && this._alive(e) ? this._view(e, viewerId, true) : null; }
    activeCount(ownerId) { return Object.values(this.data.items).filter(e => e.ownerId === ownerId && this._alive(e)).length; }

    _snapshot(attach) {
        if (!attach || typeof attach !== 'object' || typeof attach.id !== 'string' || !this.services) return null;
        const s = this.services.get(attach.id);
        if (!s) return null;
        return { id: s.id, title: s.title, price: s.price || 0, unit: s.unit || '', city: s.city || '', thumb: s.thumb || '', ownerName: s.ownerName };
    }

    async create(user, payload) {
        const t = this.now();
        const c = cleanDviz(payload, t);
        if (!c.ok) return c;
        if (this.activeCount(user.id) >= MAX_ACTIVE_PER_USER) return fail('TOO_MANY_DVIZ');
        const attached = this._snapshot(payload.attach);
        if (payload.attach && !attached) return fail('SERVICE_NOT_FOUND');
        const e = { id: 'dv_' + crypto.randomBytes(8).toString('hex'), ownerId: user.id, ownerName: user.name, created: t, ...c.value, ...(attached ? { attached } : {}), comments: [], joins: [] };
        const added = JSON.stringify(e).length;
        if (this.bytes + added > MAX_BYTES) return fail('LISTINGS_FULL');
        this.data.items[e.id] = e; this.bytes += added;
        try { await this.file.save(this.data); }
        catch (err) { delete this.data.items[e.id]; this.bytes -= added; this.logger.error?.(`dviz: ${err.code || err.message}`); return fail('STORE_UNAVAILABLE'); }
        return { ok: true, event: this._view(e, user.id, true) };
    }

    async remove(user, id, { admin = false } = {}) {
        const e = typeof id === 'string' ? this.data.items[id] : null;
        if (!e) return fail('DVIZ_NOT_FOUND');
        if (!admin && (!user || e.ownerId !== user.id)) return fail('NOT_OWNER');
        delete this.data.items[id];
        try { await this.file.save(this.data); }
        catch (err) { this.data.items[id] = e; return fail('STORE_UNAVAILABLE'); }
        this.bytes = JSON.stringify(this.data).length;
        return { ok: true, event: e };
    }

    async comment(user, id, rawText) {
        const e = typeof id === 'string' ? this.data.items[id] : null;
        if (!e || !this._alive(e)) return fail('DVIZ_NOT_FOUND');
        const t = normalizeText(typeof rawText === 'string' ? rawText : '', COMMENT_MAX);
        if (!t.ok || !t.value) return fail('EMPTY_MESSAGE');
        const c = { id: 'dc_' + this.now() + '_' + crypto.randomBytes(4).toString('hex'), userId: user.id, name: user.name, text: t.value, time: this.now() };
        e.comments.push(c);
        const dropped = [];
        while (e.comments.length > COMMENT_CAP) dropped.push(e.comments.shift());
        try { await this.file.save(this.data); }
        catch (err) { const i = e.comments.lastIndexOf(c); if (i >= 0) e.comments.splice(i, 1); e.comments.unshift(...dropped); return fail('STORE_UNAVAILABLE'); }
        return { ok: true, comment: { id: c.id, userId: c.userId, name: c.name, text: c.text, time: c.time }, event: this._view(e, user.id, false), ownerId: e.ownerId, title: e.title };
    }

    async removeComment(user, id, commentId, { admin = false } = {}) {
        const e = typeof id === 'string' ? this.data.items[id] : null;
        if (!e) return fail('DVIZ_NOT_FOUND');
        const i = e.comments.findIndex(c => c.id === commentId);
        if (i < 0) return fail('DVIZ_NOT_FOUND');
        if (!admin && e.comments[i].userId !== user.id && e.ownerId !== user.id) return fail('NOT_OWNER');
        const [c] = e.comments.splice(i, 1);
        try { await this.file.save(this.data); }
        catch (err) { e.comments.splice(i, 0, c); return fail('STORE_UNAVAILABLE'); }
        return { ok: true };
    }

    // «Я с вами»: переключатель отклика
    async toggleJoin(user, id) {
        const e = typeof id === 'string' ? this.data.items[id] : null;
        if (!e || !this._alive(e)) return fail('DVIZ_NOT_FOUND');
        if (e.ownerId === user.id) return fail('DVIZ_OWN');
        const i = e.joins.findIndex(j => j.userId === user.id);
        let rec = null;
        if (i >= 0) rec = e.joins.splice(i, 1)[0];
        else {
            if (e.joins.length >= (e.max || JOIN_CAP)) return fail('DVIZ_FULL');
            e.joins.push({ userId: user.id, name: user.name, time: this.now() });
        }
        try { await this.file.save(this.data); }
        catch (err) { if (i >= 0) e.joins.splice(i, 0, rec); else e.joins.pop(); return fail('STORE_UNAVAILABLE'); }
        return { ok: true, joined: i < 0, event: this._view(e, user.id, false), ownerId: e.ownerId, title: e.title };
    }

    async renameOwner(userId, name) {
        let n = 0;
        for (const e of Object.values(this.data.items)) {
            if (e.ownerId === userId && e.ownerName !== name) { e.ownerName = name; n++; }
            for (const c of e.comments) if (c.userId === userId && c.name !== name) { c.name = name; n++; }
            for (const j of e.joins) if (j.userId === userId && j.name !== name) { j.name = name; n++; }
        }
        if (n) { try { await this.file.save(this.data); } catch (err) { this.logger.error?.(`dviz rename: ${err.code || err.message}`); } }
        return n;
    }

    listAll() {
        return Object.values(this.data.items).sort((a, b) => b.created - a.created).slice(0, 300).map(e => ({
            id: e.id, ownerId: e.ownerId, ownerName: e.ownerName, created: e.created, title: e.title, when: e.when, place: e.place,
            comments: e.comments.length, joins: e.joins.length, photos: e.photos.length, active: this._alive(e)
        }));
    }
}

module.exports = { DvizStore, cleanDviz };
