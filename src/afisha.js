'use strict';
// ============================================
// «Афиша»: то, что на главной в блоке «Чем заняться сегодня?» добавляет администратор:
// концерты и события, истории про Архипо-Осиповку, интересные места (водопады, тропы, смотровые).
// Пользователи афишу только читают. Хранилище — файл afisha.json.
//  • событие с датой пропадает через 6 часов после начала; история и место живут, пока их не уберут;
//  • «закреплённое» всегда стоит в начале ленты;
//  • в публичном списке картинка уменьшена (thumb), полный размер отдаётся по id.
// ============================================
const crypto = require('crypto');
const path = require('path');
const { JsonFile } = require('./jsonfile');
const { normalizeText, validateImage, fail } = require('./validate');

const KINDS = ['event', 'story', 'place', 'news'];
const MAX_ITEMS = 100, MAX_BYTES = 40 * 1048576;
const IMAGE_BYTES = 350_000, THUMB_BYTES = 80_000;
const HOUR = 3600000, DAY = 86400000;
const WHEN_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const whenMs = (w) => { const t = Date.parse(w + ':00+03:00'); return Number.isFinite(t) ? t : NaN; };    // время курорта (МСК)

function cleanAfisha(raw, now) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('BAD_REQUEST');
    const kind = KINDS.includes(raw.kind) ? raw.kind : 'event';
    const t = normalizeText(typeof raw.title === 'string' ? raw.title : '', 80);
    if (!t.ok || !t.value) return fail('AFISHA_TITLE');
    const d = normalizeText(typeof raw.text === 'string' ? raw.text : '', 2000);
    if (!d.ok) return fail('AFISHA_TEXT');
    const p = normalizeText(typeof raw.place === 'string' ? raw.place : '', 120);
    if (!p.ok) return fail('BAD_REQUEST');
    let when = '';
    if (raw.when !== undefined && raw.when !== null && raw.when !== '') {
        if (typeof raw.when !== 'string' || !WHEN_RE.test(raw.when)) return fail('AFISHA_WHEN');
        const ms = whenMs(raw.when);
        if (Number.isNaN(ms) || ms < now - 30 * DAY || ms > now + 400 * DAY) return fail('AFISHA_WHEN');
        when = raw.when;
    }
    let coords = null;
    if (raw.coords !== undefined && raw.coords !== null) {
        const c = raw.coords;
        if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== 'number' || typeof c[1] !== 'number'
            || !Number.isFinite(c[0]) || !Number.isFinite(c[1]) || Math.abs(c[0]) > 90 || Math.abs(c[1]) > 180) return fail('BAD_REQUEST');
        coords = [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5];
    }
    // ссылка только http(s): «javascript:» и подобное не принимаем
    let link = '';
    if (raw.link !== undefined && raw.link !== null && raw.link !== '') {
        if (typeof raw.link !== 'string' || raw.link.length > 300) return fail('AFISHA_LINK');
        let u; try { u = new URL(raw.link.trim()); } catch (_) { return fail('AFISHA_LINK'); }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return fail('AFISHA_LINK');
        link = u.toString();
    }
    const out = { kind, title: t.value, text: d.value, place: p.value, when, link, pinned: !!raw.pinned, ...(coords ? { coords } : {}) };
    // картинка: undefined — не менять; пустая строка — убрать
    if (raw.image !== undefined) {
        if (raw.image === '' || raw.image === null) { out.image = ''; out.thumb = ''; }
        else {
            const r = validateImage(raw.image, IMAGE_BYTES); if (!r.ok) return fail('IMAGE_INVALID');
            out.image = r.value;
            if (raw.thumb) { const th = validateImage(raw.thumb, THUMB_BYTES); if (!th.ok) return fail('IMAGE_INVALID'); out.thumb = th.value; }
            else out.thumb = r.value.length <= Math.ceil(THUMB_BYTES * 4 / 3) + 128 ? r.value : '';
        }
    }
    return { ok: true, value: out };
}

class AfishaStore {
    constructor({ dataDir, now = Date.now, logger = console, fsImpl }) {
        this.file = new JsonFile({ file: path.join(dataDir, 'afisha.json'), fsImpl });
        this.now = now; this.logger = logger;
        this.data = { items: {} };
        this.bytes = 0;
    }

    async init() {
        const d = await this.file.load({});
        this.data = { items: d.items || {} };
        this.bytes = JSON.stringify(this.data).length;
        this.logger.info?.(`Афиша: ${Object.keys(this.data.items).length}, ${(this.bytes / 1048576).toFixed(1)} МБ`);
    }

    _expires(e) { const w = e.when ? whenMs(e.when) : NaN; return Number.isNaN(w) ? Infinity : w + 6 * HOUR; }
    _alive(e) { return this._expires(e) > this.now(); }

    _view(e, full) {
        return {
            id: e.id, kind: e.kind, title: e.title, text: full ? e.text : e.text.slice(0, 200), place: e.place || '', when: e.when || '',
            coords: e.coords || null, link: e.link || '', pinned: !!e.pinned, created: e.created, updated: e.updated,
            thumb: e.thumb || '', hasImage: !!e.image,
            ...(full ? { image: e.image || '' } : {})
        };
    }

    // публичная лента: закреплённое сверху, дальше свежее; ближайшие события раньше давних историй не выдвигаем — порядок по правке
    listPublic(limit = 30) {
        return Object.values(this.data.items).filter(e => this._alive(e))
            .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated)
            .slice(0, limit).map(e => this._view(e, false));
    }
    get(id) { const e = typeof id === 'string' ? this.data.items[id] : null; return e && this._alive(e) ? this._view(e, true) : null; }
    // для админа: всё, включая прошедшие события
    listAll() {
        return Object.values(this.data.items).sort((a, b) => b.updated - a.updated)
            .map(e => ({ ...this._view(e, true), expired: !this._alive(e), image: undefined }));
    }
    getAny(id) { const e = typeof id === 'string' ? this.data.items[id] : null; return e ? { ...this._view(e, true), expired: !this._alive(e) } : null; }

    async save(payload, id = '') {
        const t = this.now();
        const c = cleanAfisha(payload, t);
        if (!c.ok) return c;
        const old = id ? this.data.items[id] : null;
        if (id && !old) return fail('AFISHA_NOT_FOUND');
        if (!old && Object.keys(this.data.items).length >= MAX_ITEMS) return fail('AFISHA_FULL');
        const e = old ? { ...old, ...c.value, updated: t } : { id: 'af_' + crypto.randomBytes(8).toString('hex'), created: t, updated: t, image: '', thumb: '', ...c.value };
        if (!e.coords) delete e.coords;
        const next = { ...this.data.items, [e.id]: e };
        const total = JSON.stringify({ items: next }).length;
        if (total > MAX_BYTES) return fail('LISTINGS_FULL');
        const prev = this.data.items;
        this.data.items = next;
        try { await this.file.save(this.data); }
        catch (err) { this.data.items = prev; this.logger.error?.(`afisha: ${err.code || err.message}`); return fail('STORE_UNAVAILABLE'); }
        this.bytes = total;
        return { ok: true, item: this.getAny(e.id) };
    }

    async remove(id) {
        const e = typeof id === 'string' ? this.data.items[id] : null;
        if (!e) return fail('AFISHA_NOT_FOUND');
        delete this.data.items[id];
        try { await this.file.save(this.data); }
        catch (err) { this.data.items[id] = e; return fail('STORE_UNAVAILABLE'); }
        this.bytes = JSON.stringify(this.data).length;
        return { ok: true, item: e };
    }
}

module.exports = { AfishaStore, cleanAfisha, KINDS };
