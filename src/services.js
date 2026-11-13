'use strict';
// ============================================
// Карточки развлечений в профиле: «морские прогулки», «экскурсии», «прогулки на джипах».
//  • карточку создаёт вошедший пользователь, у неё до 4 фото, цена и описание;
//  • её видят все: в профиле автора и в разделе «Развлечения»;
//  • менять, поднимать и удалять может автор, удалить любую — модератор;
//  • поднять (опубликовать заново) можно раз в 6 часов: карточка встаёт наверх ленты.
// Фото хранятся в services.json как у объявлений (проверка по содержимому, лимиты размера).
// ============================================
const crypto = require('crypto');
const path = require('path');
const { JsonFile } = require('./jsonfile');
const { normalizeText, validateImage, fail } = require('./validate');

const MAX_PER_USER = 10, MAX_PHOTOS = 4, PHOTO_BYTES = 350_000, THUMB_BYTES = 60_000;
const MAX_BYTES = 80 * 1048576;                       // общий потолок services.json
const BUMP_COOLDOWN_MS = 6 * 3600 * 1000;
const TAGS = ['sea', 'tours', 'active', 'kids', 'show', 'food', 'other'];   // морские прогулки, экскурсии, активный отдых, детям, шоу и вечера, еда
const UNITS = ['', 'за человека', 'за час', 'за день', 'за билет', 'за лодку / группу'];

const num = (v, min, max) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : NaN;
};

function cleanService(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('BAD_REQUEST');
    const t = normalizeText(raw.title, 80); if (!t.ok) return fail('SERVICE_TITLE');
    if (!t.value) return fail('SERVICE_TITLE');
    const d = normalizeText(typeof raw.text === 'string' ? raw.text : '', 800); if (!d.ok) return fail('SERVICE_TEXT');
    const c = normalizeText(typeof raw.city === 'string' ? raw.city : '', 60); if (!c.ok) return fail('BAD_REQUEST');
    const tag = TAGS.includes(raw.tag) ? raw.tag : 'other';
    const unit = UNITS.includes(raw.unit) ? raw.unit : '';
    const price = num(raw.price, 1, 10_000_000);
    if (Number.isNaN(price)) return fail('BAD_REQUEST');
    const pl = normalizeText(typeof raw.place === 'string' ? raw.place : '', 120); if (!pl.ok) return fail('BAD_REQUEST');
    let coords = null;
    if (raw.coords !== undefined && raw.coords !== null) {
        const c = raw.coords;
        if (!Array.isArray(c) || c.length !== 2 || !c.every(Number.isFinite) || Math.abs(c[0]) > 90 || Math.abs(c[1]) > 180) return fail('BAD_REQUEST');
        coords = [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5];
    }
    const photos = [];
    if (raw.photos !== undefined && !Array.isArray(raw.photos)) return fail('IMAGE_INVALID');
    for (const p of (raw.photos || []).slice(0, MAX_PHOTOS + 1)) {
        const r = validateImage(p, PHOTO_BYTES);
        if (!r.ok) return fail('IMAGE_INVALID');
        photos.push(r.value);
    }
    if (photos.length > MAX_PHOTOS) return fail('IMAGE_INVALID');
    let thumb = '';
    if (raw.thumb) { const r = validateImage(raw.thumb, THUMB_BYTES); if (!r.ok) return fail('IMAGE_INVALID'); thumb = r.value; }
    else if (photos[0] && photos[0].length <= Math.ceil(THUMB_BYTES * 4 / 3) + 128) thumb = photos[0];
    return { ok: true, value: { title: t.value, text: d.value, city: c.value, place: pl.value, coords, tag, unit, price, photos, thumb } };
}

class ServiceStore {
    constructor({ dataDir, accounts, now = Date.now, logger = console, fsImpl }) {
        this.file = new JsonFile({ file: path.join(dataDir, 'services.json'), fsImpl });
        this.accounts = accounts; this.now = now; this.logger = logger;
        this.data = { items: {} };
        this.bytes = 0;
    }

    async init() {
        const d = await this.file.load({});
        this.data = { items: d.items || {} };
        this.bytes = JSON.stringify(this.data).length;
        this.logger.info?.(`Развлечения: ${Object.keys(this.data.items).length}, ${(this.bytes / 1048576).toFixed(1)} МБ`);
    }

    _view(s, full) {
        const u = this.accounts.byId(s.ownerId);
        return {
            id: s.id, ownerId: s.ownerId, ownerName: u ? u.name : s.ownerName, verified: !!(u && u.verified),
            created: s.created, updated: s.updated, title: s.title, text: full ? s.text : s.text.slice(0, 140), city: s.city,
            tag: s.tag, unit: s.unit, price: s.price, thumb: s.thumb || '', photoCount: s.photos.length,
            place: s.place || '', coords: s.coords || null,
            ...(full ? { photos: s.photos } : {})
        };
    }

    // Лента: свежие сверху. owner — карточки одного человека
    list({ ownerId = '', limit = 60 } = {}) {
        return Object.values(this.data.items).filter(s => !ownerId || s.ownerId === ownerId)
            .sort((a, b) => b.updated - a.updated).slice(0, limit).map(s => this._view(s, false));
    }
    get(id) { const s = typeof id === 'string' ? this.data.items[id] : null; return s ? this._view(s, true) : null; }
    count(ownerId) { return Object.values(this.data.items).filter(s => s.ownerId === ownerId).length; }

    async save(user, payload) {
        const c = cleanService(payload);
        if (!c.ok) return c;
        const id = payload && typeof payload.id === 'string' ? payload.id : null;
        let s = id ? this.data.items[id] : null;
        if (id && !s) return fail('SERVICE_NOT_FOUND');
        if (s && s.ownerId !== user.id) return fail('NOT_OWNER');
        if (!s && this.count(user.id) >= MAX_PER_USER) return fail('TOO_MANY_SERVICES');
        const prev = s ? JSON.parse(JSON.stringify(s)) : null;
        const added = JSON.stringify(c.value).length - (prev ? JSON.stringify(prev).length : 0);
        if (this.bytes + added > MAX_BYTES) return fail('LISTINGS_FULL');
        const t = this.now();
        if (!s) { s = { id: 's_' + crypto.randomBytes(8).toString('hex'), ownerId: user.id, ownerName: user.name, created: t }; this.data.items[s.id] = s; }
        Object.assign(s, c.value); s.updated = t; s.ownerName = user.name;
        const oldBytes = this.bytes; this.bytes += added;
        try { await this.file.save(this.data); }
        catch (e) {
            this.bytes = oldBytes;
            if (prev) this.data.items[s.id] = prev; else delete this.data.items[s.id];
            this.logger.error?.(`services: ${e.code || e.message}`);
            return fail('STORE_UNAVAILABLE');
        }
        return { ok: true, service: this._view(s, true), created: !prev };
    }

    // «Опубликовать заново»: карточка встаёт наверх ленты без правок
    async bump(user, id) {
        const s = typeof id === 'string' ? this.data.items[id] : null;
        if (!s) return fail('SERVICE_NOT_FOUND');
        if (s.ownerId !== user.id) return fail('NOT_OWNER');
        const t = this.now();
        if (s.bumpedAt && t - s.bumpedAt < BUMP_COOLDOWN_MS) return fail('BUMP_WAIT', { wait: Math.ceil((BUMP_COOLDOWN_MS - (t - s.bumpedAt)) / 1000) });
        const prev = { updated: s.updated, bumpedAt: s.bumpedAt };
        s.updated = t; s.bumpedAt = t;
        try { await this.file.save(this.data); }
        catch (e) { s.updated = prev.updated; if (prev.bumpedAt === undefined) delete s.bumpedAt; else s.bumpedAt = prev.bumpedAt; return fail('STORE_UNAVAILABLE'); }
        return { ok: true, service: this._view(s, false) };
    }

    async remove(user, id, { admin = false } = {}) {
        const s = typeof id === 'string' ? this.data.items[id] : null;
        if (!s) return fail('SERVICE_NOT_FOUND');
        if (!admin && (!user || s.ownerId !== user.id)) return fail('NOT_OWNER');
        delete this.data.items[id];
        try { await this.file.save(this.data); }
        catch (e) { this.data.items[id] = s; return fail('STORE_UNAVAILABLE'); }
        this.bytes = JSON.stringify(this.data).length;
        return { ok: true, service: s };
    }

    async renameOwner(userId, name) {
        let n = 0;
        for (const s of Object.values(this.data.items)) if (s.ownerId === userId && s.ownerName !== name) { s.ownerName = name; n++; }
        if (n) { try { await this.file.save(this.data); } catch (e) { this.logger.error?.(`services rename: ${e.code || e.message}`); } }
        return n;
    }

    listAll() {
        return Object.values(this.data.items).sort((a, b) => b.created - a.created).slice(0, 500).map(s => ({
            id: s.id, ownerId: s.ownerId, ownerName: s.ownerName, created: s.created, title: s.title, price: s.price,
            city: s.city, thumb: s.thumb || '', photos: s.photos.length
        }));
    }
}

// Удаление карточек развлечений пользователя (при удалении аккаунта)
ServiceStore.prototype.eraseUser = async function (userId) {
    const gone = Object.values(this.data.items).filter(s => s.ownerId === userId);
    if (!gone.length) return 0;
    for (const s of gone) delete this.data.items[s.id];
    try { await this.file.save(this.data); }
    catch (e) { for (const s of gone) this.data.items[s.id] = s; throw e; }
    if (typeof this.bytes === 'number') this.bytes = JSON.stringify(this.data).length;
    return gone.length;
};

module.exports = { ServiceStore, cleanService, TAGS, UNITS };
