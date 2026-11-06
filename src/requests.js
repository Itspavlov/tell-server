'use strict';
// ============================================
// Запросы арендаторов («Ищу жильё»).
// Это отдельные записи со своим id, статусом и сроком жизни, а не просто сообщения чата.
// Правила (всё проверяется здесь, на сервере):
//  • новый запрос — не чаще раза в 60 секунд на аккаунт (с любого устройства и вкладки);
//  • правка запроса не считается новой публикацией и не поднимает его в ленте;
//  • одинаковый активный запрос от одного человека второй раз не принимается;
//  • срок жизни 14 дней, потом статус «Истёк срок».
// Проверка и учёт лимита идут синхронно, до первого await: параллельные запросы лимит не обходят.
// ============================================
const crypto = require('crypto');
const path = require('path');
const { JsonFile } = require('./jsonfile');
const { normalizeText, fail } = require('./validate');

const CATEGORIES = ['apartment', 'house', 'hotel', 'room', 'guest'];
const STATUSES = ['active', 'found', 'closed'];   // «истёк» вычисляется по времени
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86400000;

const text = (v, max) => { const r = normalizeText(typeof v === 'string' ? v : '', max); return r.ok ? r.value : ''; };
const num = (v, min, max) => { if (v === '' || v === null || v === undefined) return null; const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null; };
const validDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

function cleanRequest(raw, today) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('BAD_REQUEST');
    const category = CATEGORIES.includes(raw.category) ? raw.category : '';
    const city = text(raw.city, 60), district = text(raw.district, 60), note = text(raw.text, 300);
    const from = typeof raw.dateFrom === 'string' && raw.dateFrom ? raw.dateFrom : '';
    const to = typeof raw.dateTo === 'string' && raw.dateTo ? raw.dateTo : '';
    if ((from && !validDate(from)) || (to && !validDate(to))) return fail('BAD_REQUEST');
    if (from && from < today) return fail('BAD_REQUEST');
    if (to && !from) return fail('BAD_REQUEST');
    if (from && to && to < from) return fail('BAD_REQUEST');
    if (raw.guests !== undefined && raw.guests !== '' && raw.guests !== null && num(raw.guests, 1, 30) === null) return fail('BAD_REQUEST');
    if (raw.budget !== undefined && raw.budget !== '' && raw.budget !== null && num(raw.budget, 1, 10_000_000) === null) return fail('BAD_REQUEST');
    const guests = num(raw.guests, 1, 30), budget = num(raw.budget, 1, 10_000_000);
    if (!city && !note && !category) return fail('BAD_REQUEST');   // совсем пустой запрос не нужен
    return { ok: true, value: { category, city, district, dateFrom: from, dateTo: to, guests, budget, text: note } };
}

const sig = (v) => crypto.createHash('sha1').update([v.category, v.city, v.district, v.dateFrom, v.dateTo, v.guests, v.budget, v.text].map(x => String(x === null ? '' : x).toLowerCase()).join('|')).digest('hex');

class RequestStore {
    constructor({ dataDir, limits, now = Date.now, logger = console, fsImpl, dayOf }) {
        this.file = new JsonFile({ file: path.join(dataDir, 'requests.json'), fsImpl });
        this.limits = limits; this.now = now; this.logger = logger;
        this.dayOf = dayOf || ((ts) => new Date(ts).toISOString().slice(0, 10));
        this.data = { requests: {}, lastPost: {} };
    }

    async init() {
        const d = await this.file.load({});
        this.data = { requests: d.requests || {}, lastPost: d.lastPost || {} };
        this.logger.info?.(`Запросы арендаторов: ${Object.keys(this.data.requests).length}`);
    }

    _ttl() { return (this.limits.requestTtlDays || 14) * DAY; }
    _status(r) { return r.status === 'active' && this.now() > r.created + this._ttl() ? 'expired' : r.status; }

    _view(r, viewerId) {
        return {
            id: r.id, ownerId: r.ownerId, ownerName: r.ownerName, created: r.created, updated: r.updated,
            expires: r.created + this._ttl(), status: this._status(r), mine: viewerId === r.ownerId,
            category: r.category, city: r.city, district: r.district, dateFrom: r.dateFrom, dateTo: r.dateTo,
            guests: r.guests, budget: r.budget, text: r.text
        };
    }

    // Сколько секунд осталось до следующего запроса
    cooldown(userId) {
        const cd = (this.limits.requestCooldownSec || 60) * 1000;
        const last = this.data.lastPost[userId] || 0;
        return Math.max(0, Math.ceil((last + cd - this.now()) / 1000));
    }

    list({ viewerId = null, status = 'active', category = '', city = '', mine = false, limit = 100 } = {}) {
        const c = String(city || '').trim().toLowerCase();
        return Object.values(this.data.requests)
            .filter(r => !mine || r.ownerId === viewerId)
            .filter(r => status === 'all' || this._status(r) === status)
            .filter(r => !category || r.category === category)
            .filter(r => !c || (r.city || '').toLowerCase().includes(c))
            .sort((a, b) => b.created - a.created)       // порядок задаёт время создания; правки не поднимают
            .slice(0, Math.min(200, limit))
            .map(r => this._view(r, viewerId));
    }

    get(id, viewerId) { const r = typeof id === 'string' ? this.data.requests[id] : null; return r ? this._view(r, viewerId) : null; }

    async create(user, raw) {
        const t = this.now();
        const c = cleanRequest(raw, this.dayOf(t));
        if (!c.ok) return c;
        const wait = this.cooldown(user.id);
        if (wait > 0) return fail('REQUEST_WAIT', { wait });
        const mineActive = Object.values(this.data.requests).filter(r => r.ownerId === user.id && this._status(r) === 'active');
        const s = sig(c.value);
        if (mineActive.some(r => r.sig === s)) return fail('REQUEST_DUPLICATE');
        if (mineActive.length >= (this.limits.maxActiveRequests || 5)) return fail('TOO_MANY_REQUESTS');

        // учёт лимита синхронно, до сохранения
        const id = 'r_' + crypto.randomBytes(8).toString('hex');
        const prevLast = this.data.lastPost[user.id];
        this.data.lastPost[user.id] = t;
        const r = { id, ownerId: user.id, ownerName: user.name, created: t, updated: t, status: 'active', sig: s, ...c.value };
        this.data.requests[id] = r;
        try { await this.file.save(this.data); }
        catch (e) {
            delete this.data.requests[id];
            if (prevLast === undefined) delete this.data.lastPost[user.id]; else this.data.lastPost[user.id] = prevLast;
            this.logger.error?.(`requests: ${e.code || e.message}`);
            return fail('STORE_UNAVAILABLE');
        }
        return { ok: true, request: this._view(r, user.id), cooldown: this.cooldown(user.id) };
    }

    // Правка: без лимита и без подъёма в ленте
    async edit(user, id, raw) {
        const r = typeof id === 'string' ? this.data.requests[id] : null;
        if (!r) return fail('REQUEST_NOT_FOUND');
        if (r.ownerId !== user.id) return fail('NOT_OWNER');
        if (this._status(r) !== 'active') return fail('BAD_REQUEST');
        const c = cleanRequest(raw, this.dayOf(this.now()));
        if (!c.ok) return c;
        const s = sig(c.value);
        const dup = Object.values(this.data.requests).some(x => x.id !== id && x.ownerId === user.id && this._status(x) === 'active' && x.sig === s);
        if (dup) return fail('REQUEST_DUPLICATE');
        const prev = JSON.parse(JSON.stringify(r));
        Object.assign(r, c.value, { sig: s, updated: this.now() });
        try { await this.file.save(this.data); }
        catch (e) { this.data.requests[id] = prev; return fail('STORE_UNAVAILABLE'); }
        return { ok: true, request: this._view(r, user.id) };
    }

    async setStatus(user, id, status) {
        const r = typeof id === 'string' ? this.data.requests[id] : null;
        if (!r) return fail('REQUEST_NOT_FOUND');
        if (r.ownerId !== user.id) return fail('NOT_OWNER');
        if (!STATUSES.includes(status) || status === 'active') return fail('BAD_REQUEST');
        const prev = r.status;
        r.status = status; r.updated = this.now();
        try { await this.file.save(this.data); }
        catch (e) { r.status = prev; return fail('STORE_UNAVAILABLE'); }
        return { ok: true, request: this._view(r, user.id) };
    }

    // Старые завершённые запросы удаляются через 60 дней
    async sweep() {
        const limit = this.now() - 60 * DAY;
        let n = 0;
        for (const [id, r] of Object.entries(this.data.requests)) {
            if (r.created + this._ttl() < limit) { delete this.data.requests[id]; n++; }
        }
        for (const [uid, ts] of Object.entries(this.data.lastPost)) if (ts < limit) delete this.data.lastPost[uid];
        if (n) await this.file.save(this.data);
        return n;
    }
}

module.exports = { RequestStore, cleanRequest };
