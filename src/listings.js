'use strict';
// ============================================
// Объявления (жильё). Хранятся на сервере и привязаны к аккаунту:
// их видят все, менять и удалять может только автор.
// Всё, что прислал клиент, проходит очистку по белому списку полей.
// Фото: JPEG/PNG/WebP/GIF, проверка по содержимому, лимиты размера.
// Хранилище — файл listings.json (для настоящих фото позже нужен
// объектный диск/S3; здесь действует ограничение общего размера).
// ============================================
const crypto = require('crypto');
const path = require('path');
const { JsonFile } = require('./jsonfile');
const { normalizeText, validateImage, fail } = require('./validate');

// Календарный день по часовому поясу сервиса (единый сброс лимита для всех)
function dayKey(ts, tz) {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts)); }
    catch (e) { return new Date(ts).toISOString().slice(0, 10); }
}

const CATEGORIES = ['apartment', 'house', 'hotel', 'room', 'guest'];
const MAX_PER_USER = 20;
const MAX_PHOTOS = 6;
const PHOTO_BYTES = 350_000;
const THUMB_BYTES = 80_000;
const AVATAR_BYTES = 120_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ICON_RE = /^fa-[a-z0-9-]{1,30}$/;
const KEY_RE = /^[\w-]{1,30}$/;

const text = (v, max) => { const r = normalizeText(typeof v === 'string' ? v : '', max); return r.ok ? r.value : ''; };
const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

function cleanCoords(v) {
    if (!Array.isArray(v) || v.length !== 2) return null;
    const lat = num(v[0], -90, 90), lng = num(v[1], -180, 180);
    return lat === null || lng === null ? null : [lat, lng];
}

function cleanImage(v, max) {
    if (typeof v !== 'string' || !v) return null;
    const r = validateImage(v, max);
    return r.ok ? r.value : null;
}

// Возвращает { ok, value } или { ok:false }
function cleanListing(raw, rawProfile) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('BAD_LISTING');
    const type = raw.type === 'sale' ? 'sale' : 'rent';
    const category = CATEGORIES.includes(raw.category) ? raw.category : 'apartment';
    const title = text(raw.title, 100);
    const priceNum = num(raw.priceNum, 1, 1e9);
    if (title.length < 3 || priceNum === null) return fail('BAD_LISTING');

    const photos = [];
    for (const p of arr(raw.photos, MAX_PHOTOS)) {
        const img = cleanImage(p, PHOTO_BYTES);
        if (!img) return fail('IMAGE_INVALID');
        photos.push(img);
    }
    let thumb = '';
    if (raw.thumb) {
        thumb = cleanImage(raw.thumb, THUMB_BYTES);
        if (!thumb) return fail('IMAGE_INVALID');
    }

    const facts = arr(raw.facts, 6).map(f => (f && ICON_RE.test(f.i) ? { i: f.i, t: text(f.t, 60) } : null)).filter(f => f && f.t);
    const terms = arr(raw.terms, 8).map(t => (t && ICON_RE.test(t.i) ? { i: t.i, l: text(t.l, 40), v: text(t.v, 160) } : null)).filter(t => t && t.l && t.v);
    const amenities = arr(raw.amenities, 24).filter(a => typeof a === 'string' && KEY_RE.test(a));
    const rules = arr(raw.rules, 10).map(r => text(r, 120)).filter(Boolean);
    const busy = arr(raw.busy, 400).filter(d => typeof d === 'string' && DATE_RE.test(d));
    const form = raw.form && typeof raw.form === 'object' ? {
        rooms: text(raw.form.rooms, 60), guests: text(raw.form.guests, 10), from: text(raw.form.from, 10),
        out: text(raw.form.out, 10), deposit: text(raw.form.deposit, 60), how: text(raw.form.how, 160), rules: text(raw.form.rules, 1200)
    } : {};

    const pr = rawProfile && typeof rawProfile === 'object' ? rawProfile : {};
    let phone = text(pr.phone, 20);
    if (phone && !/^[+\d\s()\-]{5,20}$/.test(phone)) phone = '';
    let avatar = '';
    if (pr.avatar) { avatar = cleanImage(pr.avatar, AVATAR_BYTES) || ''; }

    return {
        ok: true,
        value: {
            ad: {
                type, category, title, priceNum,
                price: text(raw.price, 30) || String(priceNum),
                location: text(raw.location, 120),
                description: text(raw.description, 2000),
                photos, thumb, facts, terms, amenities, rules, busy, form,
                coords: cleanCoords(raw.coords), beach: cleanCoords(raw.beach),
                since: num(raw.since, 1990, 2100) || new Date().getFullYear()
            },
            owner: { phone, about: text(pr.about, 600), avatar }
        }
    };
}

class ListingStore {
    constructor({ dataDir, accounts, limits, now = Date.now, logger = console, fsImpl }) {
        this.file = new JsonFile({ file: path.join(dataDir, 'listings.json'), fsImpl });
        this.accounts = accounts;
        this.limits = limits;
        this.now = now;
        this.logger = logger;
        this.data = { listings: {}, quota: {} };
        this.bytes = 0;
    }

    async init() {
        const d = await this.file.load({ listings: {} });
        this.data = { listings: d.listings || {}, quota: d.quota || {} };
        this.bytes = JSON.stringify(this.data).length;
        this.logger.info?.(`Объявления: ${Object.keys(this.data.listings).length}, ${(this.bytes / 1048576).toFixed(1)} МБ`);
    }

    _compose(l, full) {
        const a = l.ad;
        const u = this.accounts.byId(l.ownerId);
        const cover = a.thumb || '';
        return {
            id: l.id, ownerId: l.ownerId, created: l.created, updated: l.updated,
            type: a.type, category: a.category || 'apartment', title: a.title, priceNum: a.priceNum, price: a.price,
            location: a.location, description: a.description,
            image: cover || (full && a.photos[0]) || '',
            photos: full ? a.photos : (cover ? [cover] : []),
            thumb: cover, partial: !full, photoCount: a.photos.length,
            views: 0, isVerified: !!(u && u.verified), isUrgent: false,
            facts: a.facts, amenities: a.amenities, terms: a.terms, rules: a.rules,
            coords: a.coords, beach: a.beach, busy: a.busy, form: full ? a.form : undefined,
            since: a.since,
            owner: {
                id: l.ownerId, name: u ? u.name : l.ownerName, phone: l.owner.phone, color: '#FF7A59',
                since: a.since, about: l.owner.about, avatar: l.owner.avatar, rating: null, reviews: 0, response: ''
            }
        };
    }

    // Сколько новых объявлений аккаунт опубликовал сегодня. Удаление счётчик не уменьшает.
    quota(userId) {
        const limit = this.limits.dailyListings || 3;
        const day = dayKey(this.now(), this.limits.serviceTz);
        const q = this.data.quota[userId];
        const used = q && q.day === day ? q.n : 0;
        return { used, limit, left: Math.max(0, limit - used), day };
    }

    list() {
        return Object.values(this.data.listings)
            .sort((a, b) => b.updated - a.updated).slice(0, 200)
            .map(l => this._compose(l, false));
    }

    get(id) {
        const l = typeof id === 'string' ? this.data.listings[id] : null;
        return l ? this._compose(l, true) : null;
    }

    async save(user, payload) {
        if (!user.verified) return fail('NOT_VERIFIED');
        const c = cleanListing(payload && payload.ad, payload && payload.profile);
        if (!c.ok) return c;
        const id = payload && typeof payload.id === 'string' ? payload.id : null;
        let l = id ? this.data.listings[id] : null;
        if (id && !l) return fail('LISTING_NOT_FOUND');
        if (l && l.ownerId !== user.id) return fail('NOT_OWNER');

        const mine = Object.values(this.data.listings).filter(x => x.ownerId === user.id).length;
        if (!l && mine >= MAX_PER_USER) return fail('TOO_MANY_LISTINGS');

        const prev = l ? JSON.parse(JSON.stringify(l)) : null;
        const added = JSON.stringify(c.value).length - (prev ? JSON.stringify({ ad: prev.ad, owner: prev.owner }).length : 0);
        if (this.bytes + added > this.limits.maxListingsBytes) return fail('LISTINGS_FULL');

        // Дневной лимит: проверка и учёт идут синхронно (до первого await),
        // поэтому параллельные запросы не пробьют лимит
        const isNew = !l;
        let quotaPrev;
        if (isNew) {
            const q = this.quota(user.id);
            if (q.left <= 0) return fail('DAILY_LIMIT', { quota: q });
            quotaPrev = this.data.quota[user.id];
            this.data.quota[user.id] = { day: q.day, n: q.used + 1 };
        }

        const t = this.now();
        if (!l) {
            l = { id: 'l_' + crypto.randomBytes(8).toString('hex'), ownerId: user.id, ownerName: user.name, created: t };
            this.data.listings[l.id] = l;
        }
        l.ad = c.value.ad; l.owner = c.value.owner; l.updated = t; l.ownerName = user.name;
        const oldBytes = this.bytes;
        this.bytes += added;
        try { await this.file.save(this.data); }
        catch (e) {
            this.bytes = oldBytes;
            if (isNew) { if (quotaPrev === undefined) delete this.data.quota[user.id]; else this.data.quota[user.id] = quotaPrev; }
            if (prev) this.data.listings[l.id] = prev; else delete this.data.listings[l.id];
            this.logger.error?.(`listings: ${e.code || e.message}`);
            return fail('STORE_UNAVAILABLE');
        }
        return { ok: true, listing: this._compose(l, true), quota: this.quota(user.id) };
    }

    // Для подбора: объявления в «сыром» виде и лёгкая карточка для показа
    raws() { return Object.values(this.data.listings); }
    rawById(id) { return typeof id === 'string' ? this.data.listings[id] || null : null; }
    light(l) { return this._compose(l, false); }

    // Для модерации: все объявления с владельцами
    listAll() {
        return Object.values(this.data.listings).sort((a, b) => b.created - a.created).slice(0, 500).map(l => ({
            id: l.id, ownerId: l.ownerId, ownerName: l.ownerName, created: l.created, updated: l.updated,
            title: l.ad && l.ad.title, price: l.ad && l.ad.price, location: l.ad && l.ad.location,
            thumb: (l.ad && (l.ad.thumb || (l.ad.photos && l.ad.photos[0]))) || '', photos: (l.ad && l.ad.photos || []).length,
            phone: l.owner && l.owner.phone || ''
        }));
    }

    async removeAny(id) {
        const l = typeof id === 'string' ? this.data.listings[id] : null;
        if (!l) return fail('LISTING_NOT_FOUND');
        delete this.data.listings[id];
        try { await this.file.save(this.data); }
        catch (e) { this.data.listings[id] = l; return fail('STORE_UNAVAILABLE'); }
        this.bytes = JSON.stringify(this.data).length;
        return { ok: true, ownerName: l.ownerName, ownerId: l.ownerId, title: l.ad && l.ad.title };
    }

    async remove(user, id) {
        const l = typeof id === 'string' ? this.data.listings[id] : null;
        if (!l) return fail('LISTING_NOT_FOUND');
        if (l.ownerId !== user.id) return fail('NOT_OWNER');
        delete this.data.listings[id];
        try { await this.file.save(this.data); }
        catch (e) { this.data.listings[id] = l; return fail('STORE_UNAVAILABLE'); }
        this.bytes = JSON.stringify(this.data).length;
        return { ok: true };
    }
}

module.exports = { ListingStore, cleanListing, dayKey };
