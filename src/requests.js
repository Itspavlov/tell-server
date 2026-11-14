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
const { matches, similar } = require('./match');
const { ID_RE: MEDIA_ID_RE } = require('./media');

const CATEGORIES = ['apartment', 'house', 'hotel', 'room', 'guest'];
const SECTIONS = ['housing', 'work', 'trips', 'services'];   // раздел, где лежит карточка
const KINDS = ['seek', 'offer'];                            // «Ищу» / «Предоставляю» (для жилья «Предоставляю» — обычное объявление)
const STATUSES = ['active', 'found', 'closed'];   // «истёк» вычисляется по времени
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86400000;
const MAX_CAR_PHOTOS = 3;                               // фото автомобиля в карточке «Предлагаю поездку»

const text = (v, max) => { const r = normalizeText(typeof v === 'string' ? v : '', max); return r.ok ? r.value : ''; };
const num = (v, min, max) => { if (v === '' || v === null || v === undefined) return null; const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null; };
const validDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

function cleanRequest(raw, today) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('BAD_REQUEST');
    const section = SECTIONS.includes(raw.section) ? raw.section : 'housing';
    const housing = section === 'housing';
    // у жилья «Предоставляю» — это объявление, а не запрос
    const kind = housing ? 'seek' : (KINDS.includes(raw.kind) ? raw.kind : 'seek');
    const category = housing && CATEGORIES.includes(raw.category) ? raw.category : '';
    const city = text(raw.city, 60), district = housing ? text(raw.district, 60) : '', note = text(raw.text, 300);
    const title = housing ? '' : text(raw.title, 80);
    const from = typeof raw.dateFrom === 'string' && raw.dateFrom ? raw.dateFrom : '';
    const to = typeof raw.dateTo === 'string' && raw.dateTo ? raw.dateTo : '';
    if ((from && !validDate(from)) || (to && !validDate(to))) return fail('BAD_REQUEST');
    if (from && from < today) return fail('BAD_REQUEST');
    if (to && !from) return fail('BAD_REQUEST');
    if (from && to && to < from) return fail('BAD_REQUEST');
    if (raw.guests !== undefined && raw.guests !== '' && raw.guests !== null && num(raw.guests, 1, 30) === null) return fail('BAD_REQUEST');
    if (raw.budget !== undefined && raw.budget !== '' && raw.budget !== null && num(raw.budget, 1, 10_000_000) === null) return fail('BAD_REQUEST');
    const guests = num(raw.guests, 1, 30), budget = num(raw.budget, 1, 10_000_000);
    const pets = housing && (raw.pets === true || raw.pets === 'true' || raw.pets === 1 || raw.pets === '1');
    if (housing && !city && !note && !category) return fail('BAD_REQUEST');   // совсем пустой запрос не нужен
    if (!housing && !title) return fail('BAD_REQUEST');                       // у остальных разделов нужен заголовок
    const value = { section, kind, title, category, city, district, dateFrom: from, dateTo: to, guests, budget, pets, text: note };
    // фото автомобиля: только у «Предлагаю поездку», это id файлов из /api/media (принадлежность владельцу проверяет http.js)
    if (section === 'trips' && kind === 'offer' && raw.photos !== undefined) {
        if (!Array.isArray(raw.photos) || raw.photos.length > MAX_CAR_PHOTOS) return fail('IMAGE_INVALID');
        const ids = [];
        for (const id of raw.photos) {
            if (typeof id !== 'string' || !MEDIA_ID_RE.test(id)) return fail('IMAGE_INVALID');
            if (!ids.includes(id)) ids.push(id);
        }
        value.photos = ids;
    }
    return { ok: true, value };
}

const sig = (v) => crypto.createHash('sha1').update([v.section, v.kind, v.title, v.category, v.city, v.district, v.dateFrom, v.dateTo, v.guests, v.budget, v.pets ? 'pets' : '', v.text].map(x => String(x === null ? '' : x).toLowerCase()).join('|')).digest('hex');

class RequestStore {
    constructor({ dataDir, limits, now = Date.now, logger = console, fsImpl, dayOf }) {
        this.file = new JsonFile({ file: path.join(dataDir, 'requests.json'), fsImpl });
        this.limits = limits; this.now = now; this.logger = logger;
        this.dayOf = dayOf || ((ts) => new Date(ts).toISOString().slice(0, 10));
        this.data = { requests: {}, lastPost: {}, offers: {} };
    }

    async renameOwner(userId, name) {
        let n = 0;
        for (const r of Object.values(this.data.requests)) if (r.ownerId === userId && r.ownerName !== name) { r.ownerName = name; n++; }
        for (const o of Object.values(this.data.offers || {})) if (o.ownerId === userId && o.ownerName !== name) { o.ownerName = name; n++; }
        if (n) { try { await this.file.save(this.data); } catch (e) { this.logger.error?.(`requests rename: ${e.code || e.message}`); } }
        return n;
    }

    async init() {
        const d = await this.file.load({});
        this.data = { requests: d.requests || {}, lastPost: d.lastPost || {}, offers: d.offers || {} };
        this.logger.info?.(`Запросы арендаторов: ${Object.keys(this.data.requests).length}`);
    }

    _ttl() { return (this.limits.requestTtlDays || 14) * DAY; }
    _status(r) { return r.status === 'active' && this.now() > r.created + this._ttl() ? 'expired' : r.status; }

    _view(r, viewerId) {
        return {
            id: r.id, ownerId: r.ownerId, ownerName: r.ownerName, created: r.created, updated: r.updated,
            expires: r.created + this._ttl(), status: this._status(r), mine: viewerId === r.ownerId,
            section: r.section || 'housing', kind: r.kind || 'seek', title: r.title || '', category: r.category, city: r.city, district: r.district, dateFrom: r.dateFrom, dateTo: r.dateTo,
            guests: r.guests, budget: r.budget, pets: !!r.pets, text: r.text, notify: r.notify !== false,
            photos: Array.isArray(r.photos) ? r.photos : []
        };
    }

    // Сколько секунд осталось до следующего запроса
    cooldown(userId) {
        const cd = (this.limits.requestCooldownSec || 60) * 1000;
        const last = this.data.lastPost[userId] || 0;
        return Math.max(0, Math.ceil((last + cd - this.now()) / 1000));
    }

    list({ viewerId = null, status = 'active', category = '', city = '', mine = false, limit = 100, section = '', kind = '' } = {}) {
        const c = String(city || '').trim().toLowerCase();
        return Object.values(this.data.requests)
            .filter(r => !mine || r.ownerId === viewerId)
            .filter(r => status === 'all' || this._status(r) === status)
            .filter(r => !category || r.category === category)
            .filter(r => !section || (r.section || 'housing') === section)
            .filter(r => !kind || (r.kind || 'seek') === kind)
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
        const r = { id, ownerId: user.id, ownerName: user.name, created: t, updated: t, status: 'active', sig: s, notify: true, notified: [], ...c.value };
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
        const c = cleanRequest(raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw, section: r.section || 'housing', kind: r.kind || 'seek' } : raw, this.dayOf(this.now()));
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

    // Полностью удалить свой запрос (вместе с предложениями к нему)
    async remove(user, id) {
        const r = typeof id === 'string' ? this.data.requests[id] : null;
        if (!r) return fail('REQUEST_NOT_FOUND');
        if (r.ownerId !== user.id) return fail('NOT_OWNER');
        const offers = Object.entries(this.data.offers).filter(([, o]) => o.requestId === id);
        delete this.data.requests[id];
        for (const [oid] of offers) delete this.data.offers[oid];
        try { await this.file.save(this.data); }
        catch (e) { this.data.requests[id] = r; for (const [oid, o] of offers) this.data.offers[oid] = o; return fail('STORE_UNAVAILABLE'); }
        return { ok: true };
    }

    // ---------- для модератора ----------
    listAll() {
        return Object.values(this.data.requests).sort((a, b) => b.created - a.created).slice(0, 300)
            .map(r => ({ ...this._view(r, null), offers: this.offerCount(r.id) }));
    }

    // Удалить любой запрос (вместе с предложениями к нему)
    async removeAny(id) {
        const r = typeof id === 'string' ? this.data.requests[id] : null;
        if (!r) return fail('REQUEST_NOT_FOUND');
        const offers = Object.entries(this.data.offers).filter(([, o]) => o.requestId === id);
        delete this.data.requests[id];
        for (const [oid] of offers) delete this.data.offers[oid];
        try { await this.file.save(this.data); }
        catch (e) { this.data.requests[id] = r; for (const [oid, o] of offers) this.data.offers[oid] = o; return fail('STORE_UNAVAILABLE'); }
        return { ok: true, ownerId: r.ownerId, ownerName: r.ownerName, title: r.title || '', category: r.category };
    }

    // Включить/выключить уведомления о подходящем жилье по этому запросу
    async setNotify(user, id, on) {
        const r = typeof id === 'string' ? this.data.requests[id] : null;
        if (!r) return fail('REQUEST_NOT_FOUND');
        if (r.ownerId !== user.id) return fail('NOT_OWNER');
        const prev = r.notify;
        r.notify = !!on;
        try { await this.file.save(this.data); } catch (e) { r.notify = prev; return fail('STORE_UNAVAILABLE'); }
        return { ok: true, request: this._view(r, user.id) };
    }

    // Новое или изменённое объявление: кого из арендаторов оно подходит.
    // Каждая пара «запрос — объявление» уведомляется один раз (запоминается), поэтому дублей нет.
    // Если подошло несколько запросов одного человека, уведомление одно.
    async matchesNotify(l) {
        const hit = [];
        for (const r of Object.values(this.data.requests)) {
            if (r.notify === false || r.ownerId === l.ownerId || this._status(r) !== 'active') continue;
            r.notified = r.notified || [];
            if (r.notified.includes(l.id) || !matches(r, l)) continue;
            r.notified.push(l.id);
            if (r.notified.length > 200) r.notified.shift();
            hit.push(r);
        }
        if (!hit.length) return [];
        try { await this.file.save(this.data); } catch (e) { this.logger.error?.(`requests notify: ${e.code || e.message}`); }
        const byOwner = new Map();
        for (const r of hit) { const a = byOwner.get(r.ownerId) || []; a.push(r); byOwner.set(r.ownerId, a); }
        return Array.from(byOwner, ([ownerId, rs]) => ({ ownerId, requests: rs.map(x => x.id), count: rs.length }));
    }

    // Запросы, у которых только что закончился срок: владельцам сообщаем один раз
    async expireDue() {
        const due = Object.values(this.data.requests).filter(r => this._status(r) === 'expired' && !r.expiredNotified);
        if (!due.length) return [];
        for (const r of due) r.expiredNotified = true;
        try { await this.file.save(this.data); } catch (e) { for (const r of due) delete r.expiredNotified; return []; }
        return due.map(r => ({ ownerId: r.ownerId, id: r.id, city: r.city }));
    }

    // ---------- подбор и предложения ----------
    // Подходящие объявления для запроса (карточки). Видит только автор запроса.
    matchesFor(user, id, listings) {
        const r = typeof id === 'string' ? this.data.requests[id] : null;
        if (!r) return fail('REQUEST_NOT_FOUND');
        if (r.ownerId !== user.id) return fail('NOT_OWNER');
        const mine = listings.raws().filter(l => l.ownerId !== user.id);
        const byFresh = (a, b) => b.updated - a.updated;
        const list = mine.filter(l => matches(r, l)).sort(byFresh).slice(0, 30).map(l => listings.light(l));
        // другие типы жилья: цена, гости, даты, место и животные подходят, не совпадает только тип
        const other = mine.filter(l => similar(r, l)).sort(byFresh).slice(0, 20).map(l => listings.light(l));
        return { ok: true, listings: list, similar: other };
    }

    countMatches(r, listings) { return listings.raws().filter(l => l.ownerId !== r.ownerId && matches(r, l)).length; }
    countSimilar(r, listings) { return listings.raws().filter(l => l.ownerId !== r.ownerId && similar(r, l)).length; }
    offerCount(requestId) { return Object.values(this.data.offers).filter(o => o.requestId === requestId && o.status === 'new').length; }

    // «Подходящие арендаторы»: чужие активные запросы, под которые подходит хотя бы одно моё объявление
    matchingFor(user, listings) {
        const mine = listings.raws().filter(l => l.ownerId === user.id);
        if (!mine.length) return [];
        const sent = new Set(Object.values(this.data.offers).filter(o => o.ownerId === user.id).map(o => o.requestId + '|' + o.listingId));
        return Object.values(this.data.requests)
            .filter(r => r.ownerId !== user.id && this._status(r) === 'active')
            .map(r => {
                const ok = mine.filter(l => matches(r, l));
                return ok.length ? { ...this._view(r, user.id), myMatches: ok.map(l => ({ id: l.id, title: l.ad.title, price: l.ad.price, offered: sent.has(r.id + '|' + l.id) })) } : null;
            })
            .filter(Boolean).sort((a, b) => b.created - a.created).slice(0, 50);
    }

    // Хозяин предлагает своё жильё под запрос
    async offer(user, requestId, listingId, listings) {
        const r = typeof requestId === 'string' ? this.data.requests[requestId] : null;
        if (!r) return fail('REQUEST_NOT_FOUND');
        if (r.ownerId === user.id) return fail('BAD_REQUEST');
        if (this._status(r) !== 'active') return fail('REQUEST_CLOSED');
        const l = listings.rawById(listingId);
        if (!l || l.ownerId !== user.id) return fail('LISTING_NOT_FOUND');
        if (!matches(r, l)) return fail('OFFER_MISMATCH');          // занято на эти даты, дороже бюджета и т. п.
        const all = Object.values(this.data.offers);
        if (all.some(o => o.requestId === requestId && o.listingId === listingId)) return fail('OFFER_DUPLICATE');
        if (all.filter(o => o.requestId === requestId).length >= 30) return fail('OFFERS_FULL');
        const id = 'o_' + crypto.randomBytes(8).toString('hex');
        const o = { id, requestId, listingId, ownerId: user.id, ownerName: user.name, created: this.now(), status: 'new' };
        this.data.offers[id] = o;                                    // учёт до сохранения: повтор не пройдёт
        try { await this.file.save(this.data); }
        catch (e) { delete this.data.offers[id]; return fail('STORE_UNAVAILABLE'); }
        return { ok: true, offer: o, request: r };
    }

    // Предложения хозяев по моему запросу
    offersFor(user, requestId, listings) {
        const r = typeof requestId === 'string' ? this.data.requests[requestId] : null;
        if (!r) return fail('REQUEST_NOT_FOUND');
        if (r.ownerId !== user.id) return fail('NOT_OWNER');
        const out = Object.values(this.data.offers).filter(o => o.requestId === requestId && o.status !== 'rejected').sort((a, b) => b.created - a.created)
            .map(o => { const l = listings.rawById(o.listingId); return l ? { id: o.id, created: o.created, status: o.status, ownerName: o.ownerName, listing: listings.light(l) } : null; })
            .filter(Boolean);
        return { ok: true, offers: out };
    }

    async rejectOffer(user, requestId, offerId) {
        const r = typeof requestId === 'string' ? this.data.requests[requestId] : null;
        if (!r) return fail('REQUEST_NOT_FOUND');
        if (r.ownerId !== user.id) return fail('NOT_OWNER');
        const o = typeof offerId === 'string' ? this.data.offers[offerId] : null;
        if (!o || o.requestId !== requestId) return fail('REQUEST_NOT_FOUND');
        const prev = o.status; o.status = 'rejected';
        try { await this.file.save(this.data); } catch (e) { o.status = prev; return fail('STORE_UNAVAILABLE'); }
        return { ok: true };
    }

    // Старые завершённые запросы удаляются через 60 дней
    async sweep() {
        const limit = this.now() - 60 * DAY;
        let n = 0;
        for (const [id, r] of Object.entries(this.data.requests)) {
            if (r.created + this._ttl() < limit) { delete this.data.requests[id]; n++; }
        }
        for (const [oid, o] of Object.entries(this.data.offers)) if (!this.data.requests[o.requestId]) { delete this.data.offers[oid]; n++; }
        for (const [uid, ts] of Object.entries(this.data.lastPost)) if (ts < limit) delete this.data.lastPost[uid];
        if (n) await this.file.save(this.data);
        return n;
    }
}

// Удаление запросов пользователя и всех его предложений (при удалении аккаунта)
RequestStore.prototype.eraseUser = async function (userId) {
    const mineReq = Object.values(this.data.requests).filter(r => r.ownerId === userId).map(r => r.id);
    const gone = new Set(mineReq);
    const offers = Object.entries(this.data.offers).filter(([, o]) => o.ownerId === userId || gone.has(o.requestId));
    const lastPrev = this.data.lastPost[userId];
    if (!mineReq.length && !offers.length && lastPrev === undefined) return 0;
    const reqBackup = mineReq.map(id => this.data.requests[id]);
    for (const id of mineReq) delete this.data.requests[id];
    for (const [oid] of offers) delete this.data.offers[oid];
    delete this.data.lastPost[userId];
    try { await this.file.save(this.data); }
    catch (e) {
        for (const r of reqBackup) this.data.requests[r.id] = r;
        for (const [oid, o] of offers) this.data.offers[oid] = o;
        if (lastPrev !== undefined) this.data.lastPost[userId] = lastPrev;
        throw e;
    }
    return mineReq.length + offers.length;
};

module.exports = { RequestStore, cleanRequest, MAX_CAR_PHOTOS };
