'use strict';
// ============================================
// Подписки на поиск жилья: человек сохраняет фильтры, а когда публикуется
// подходящее объявление, приходит уведомление (раз на объявление).
//  • до 10 подписок на человека;
//  • сравнение — те же правила, что у фильтров в приложении;
//  • уведомляем только о НОВЫХ объявлениях, правки старых не считаются;
//  • своё объявление не присылается самому себе.
// ============================================
const crypto = require('crypto');
const path = require('path');
const { JsonFile } = require('./jsonfile');
const { fail } = require('./validate');

const CAP = 10, SEEN_CAP = 300;
const SEA = new Set([0, 300, 1000, 3000]);
const CATS = new Set(['', 'apartment', 'house', 'hotel', 'room', 'guest']);
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();
const isoDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const numOrEmpty = (v) => { if (v === '' || v === null || v === undefined) return ''; const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1e9 ? Math.round(n) : null; };

function cleanFilter(raw) {
    const f = raw && typeof raw === 'object' ? raw : {};
    const min = numOrEmpty(f.min), max = numOrEmpty(f.max);
    if (min === null || max === null) return null;
    if (min !== '' && max !== '' && min > max) return null;
    const guests = Number(f.guests) || 0;
    const sea = Number(f.sea) || 0;
    const cat = typeof f.cat === 'string' ? f.cat : '';
    if (!Number.isInteger(guests) || guests < 0 || guests > 30 || !SEA.has(sea) || !CATS.has(cat)) return null;
    const amen = Array.isArray(f.amen) ? [...new Set(f.amen.filter(a => typeof a === 'string' && a.length <= 30 && /^[^\u0000-\u001f<>]+$/u.test(a)))].slice(0, 12) : [];
    const from = isoDay(f.from) ? f.from : '', to = isoDay(f.to) ? f.to : '';
    if (from && to && to < from) return null;
    const q = typeof f.q === 'string' ? f.q.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    return { q, min, max, from, to: from ? to : '', guests, sea, amen, verified: !!f.verified, cat };
}

const empty = (f) => !f.q && f.min === '' && f.max === '' && !f.from && !f.guests && !f.sea && !f.amen.length && !f.verified && !f.cat;

function dist(a, b) {
    const R = 6371000, r = (x) => x * Math.PI / 180;
    const dLat = r(b[0] - a[0]), dLng = r(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}
function nights(from, to) {
    const out = []; if (!from) return out;
    const a = Date.parse(from), b = to ? Date.parse(to) : a + 86400000;
    for (let t = a; t < b && out.length < 120; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
}
function capacity(ad) {
    const g = Number(ad.form && ad.form.guests);
    if (Number.isFinite(g) && g > 0) return g;
    for (const f of ad.facts || []) { const m = /до\s+(\d+)\s+гост/i.exec((f && f.t) || ''); if (m) return Number(m[1]); }
    return null;
}

// ad — объявление в «полном» виде (listings.get)
function matches(f, ad) {
    if (f.cat && (ad.category || 'apartment') !== f.cat) return false;
    if (f.q && !norm(`${ad.location} ${ad.title} ${ad.description || ''}`).includes(norm(f.q))) return false;
    const price = Number(ad.priceNum);
    if (f.min !== '' && !(price >= f.min)) return false;
    if (f.max !== '' && !(price <= f.max)) return false;
    if (f.from && ad.type !== 'sale' && ad.busy && ad.busy.length) {
        const busy = new Set(ad.busy);
        if (nights(f.from, f.to).some(d => busy.has(d))) return false;
    }
    if (f.guests) { const c = capacity(ad); if (c !== null && c < f.guests) return false; }
    if (f.sea) { if (!(ad.coords && ad.beach)) return false; if (dist(ad.coords, ad.beach) > f.sea) return false; }
    if (f.amen.length && !f.amen.every(a => (ad.amenities || []).includes(a))) return false;
    if (f.verified && !ad.isVerified) return false;
    return true;
}

class SearchStore {
    constructor({ dataDir, now = Date.now, logger = console, fsImpl }) {
        this.file = new JsonFile({ file: path.join(dataDir, 'searches.json'), fsImpl });
        this.now = now; this.logger = logger;
        this.data = { users: {} };
    }

    async init() { const d = await this.file.load({}); this.data = { users: d.users || {} }; }

    list(userId) { return (this.data.users[userId] || []).map(s => ({ id: s.id, name: s.name, filter: s.filter, created: s.created })); }

    async add(userId, payload) {
        const p = payload && typeof payload === 'object' ? payload : {};
        const f = cleanFilter(p.filter);
        if (!f) return fail('BAD_PAYLOAD');
        if (empty(f)) return fail('SEARCH_EMPTY');
        const name = typeof p.name === 'string' ? p.name.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
        const list = this.data.users[userId] || [];
        if (list.length >= CAP) return fail('SEARCH_LIMIT');
        const sig = JSON.stringify(f);
        if (list.some(s => JSON.stringify(s.filter) === sig)) return fail('SEARCH_DUPLICATE');
        const s = { id: 'ss_' + crypto.randomBytes(6).toString('hex'), name: name || 'Мой поиск', filter: f, created: this.now(), seen: [] };
        const prev = this.data.users[userId];
        this.data.users[userId] = [...list, s];
        try { await this.file.save(this.data); }
        catch (e) { if (prev) this.data.users[userId] = prev; else delete this.data.users[userId]; return fail('STORE_UNAVAILABLE'); }
        return { ok: true, search: { id: s.id, name: s.name, filter: s.filter, created: s.created }, searches: this.list(userId) };
    }

    async remove(userId, id) {
        const list = this.data.users[userId] || [];
        if (!list.some(s => s.id === id)) return fail('SEARCH_NOT_FOUND');
        const prev = list;
        const next = list.filter(s => s.id !== id);
        if (next.length) this.data.users[userId] = next; else delete this.data.users[userId];
        try { await this.file.save(this.data); }
        catch (e) { this.data.users[userId] = prev; return fail('STORE_UNAVAILABLE'); }
        return { ok: true, searches: this.list(userId) };
    }

    // Кому сообщить о новом объявлении: [{ userId, searchId, name, count }]; уже сообщённые не повторяются
    async notifyFor(ad) {
        const out = [];
        let changed = false;
        for (const [userId, list] of Object.entries(this.data.users)) {
            if (userId === ad.ownerId) continue;
            const hit = list.filter(s => !s.seen.includes(ad.id) && matches(s.filter, ad));
            if (!hit.length) continue;
            for (const s of hit) { s.seen.push(ad.id); if (s.seen.length > SEEN_CAP) s.seen.shift(); }
            changed = true;
            out.push({ userId, searchId: hit[0].id, name: hit[0].name, count: hit.length });
        }
        if (changed) await this.file.save(this.data).catch((e) => this.logger.error('searches save failed', e.message));
        return out;
    }
}

module.exports = { SearchStore, matches, cleanFilter };
