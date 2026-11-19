'use strict';
// ============================================
// «Шапка сайта»: верх главного экрана — фото, заголовок «Твой курорт», подпись и метка места.
// Администратор меняет их в панели; пустое поле или «сбросить» возвращает стандартный вид,
// который зашит в сайт. Хранилище — файл site.json. Фото отдаётся отдельным адресом
// /api/site/hero (с версией в адресе, поэтому кэшируется надолго и меняется сразу после правки).
// ============================================
const path = require('path');
const { JsonFile } = require('./jsonfile');
const { normalizeText, validateImage, fail } = require('./validate');

const PHOTO_BYTES = 450_000;
const LIMITS = { title1: 24, title2: 24, tag: 160, place: 40 };
const FIELDS = Object.keys(LIMITS);

function cleanHero(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('BAD_REQUEST');
    const out = {};
    if (raw.reset === true) { FIELDS.forEach((k) => { out[k] = ''; }); out.photo = ''; return { ok: true, value: out }; }
    for (const k of FIELDS) {
        if (raw[k] === undefined) continue;
        const t = normalizeText(typeof raw[k] === 'string' ? raw[k] : '', LIMITS[k]);
        if (!t.ok) return fail('HERO_TEXT');
        out[k] = t.value;
    }
    // фото: undefined — не менять; пустая строка — вернуть стандартное
    if (raw.photo !== undefined) {
        if (raw.photo === '' || raw.photo === null) out.photo = '';
        else { const r = validateImage(raw.photo, PHOTO_BYTES); if (!r.ok) return fail(r.code === 'IMAGE_TOO_LARGE' ? 'IMAGE_TOO_LARGE' : 'IMAGE_INVALID'); out.photo = r.value; }
    }
    return { ok: true, value: out };
}

class SiteStore {
    constructor({ dataDir, now = Date.now, logger = console, fsImpl }) {
        this.file = new JsonFile({ file: path.join(dataDir, 'site.json'), fsImpl });
        this.now = now; this.logger = logger;
        this.data = { hero: {} };
    }

    async init() {
        const d = await this.file.load({});
        this.data = { hero: d.hero && typeof d.hero === 'object' ? d.hero : {} };
    }

    // публичный вид: только то, что изменено; фото — адрес с версией
    heroPublic() {
        const h = this.data.hero;
        const out = { updated: h.updated || 0 };
        FIELDS.forEach((k) => { if (h[k]) out[k] = h[k]; });
        if (h.photo) out.photo = '/api/site/hero?v=' + (h.updated || 0);
        return out;
    }
    heroAdmin() {
        const h = this.data.hero;
        const out = { updated: h.updated || 0, photo: h.photo || '' };
        FIELDS.forEach((k) => { out[k] = h[k] || ''; });
        return out;
    }
    heroPhoto() {
        const m = /^data:([^;]+);base64,(.+)$/s.exec(this.data.hero.photo || '');
        return m ? { mime: m[1], buf: Buffer.from(m[2], 'base64') } : null;
    }

    async saveHero(payload) {
        const c = cleanHero(payload);
        if (!c.ok) return c;
        const prev = this.data.hero;
        const next = { ...prev, ...c.value, updated: this.now() };
        FIELDS.forEach((k) => { if (!next[k]) delete next[k]; });
        if (!next.photo) delete next.photo;
        this.data.hero = next;
        try { await this.file.save(this.data); }
        catch (err) { this.data.hero = prev; this.logger.error?.(`site: ${err.code || err.message}`); return fail('STORE_UNAVAILABLE'); }
        return { ok: true, hero: this.heroAdmin() };
    }
}

module.exports = { SiteStore, cleanHero, LIMITS };
