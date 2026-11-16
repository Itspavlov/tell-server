'use strict';
// ============================================
// Серверный прокси геокодера: ключ Яндекса живёт только на сервере.
// GET /api/geocode?q=...  ->  { ok:true, lat, lng, name } | { ok:false, code }
// Кэш в памяти на 24 часа, таймаут 5 с, лимит по IP ставит вызывающий код (RateLimiter).
// ============================================
const DAY = 24 * 60 * 60 * 1000;
const CENTER = { lat: 44.3667, lng: 38.5333 };          // Архипо-Осиповка
const norm = (q) => String(q || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

class Geocoder {
    constructor({ apiKey, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 5000, ttlMs = DAY, maxEntries = 2000, logger = console }) {
        this.apiKey = apiKey || '';
        this.fetch = fetchImpl; this.now = now; this.timeoutMs = timeoutMs; this.ttlMs = ttlMs; this.maxEntries = maxEntries; this.logger = logger;
        this.cache = new Map();                          // ключ -> { at, value }
    }
    get enabled() { return this.apiKey.length > 0; }

    async find(rawQ) {
        let q = norm(rawQ);
        if (q.length < 2 || q.length > 120) return { ok: false, code: 'BAD_QUERY' };
        if (!this.enabled) return { ok: false, code: 'GEOCODER_OFF' };
        if (!/архипо|осипов/.test(q)) q = 'архипо-осиповка, ' + q;
        const hit = this.cache.get(q);
        if (hit && this.now() - hit.at < this.ttlMs) return hit.value;

        const url = 'https://geocode-maps.yandex.ru/1.x/?format=json&results=1&lang=ru_RU'
            + '&apikey=' + encodeURIComponent(this.apiKey)
            + '&geocode=' + encodeURIComponent(q)
            + '&ll=' + CENTER.lng + ',' + CENTER.lat + '&spn=0.4,0.3&rspn=0';
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
        let value;
        try {
            const r = await this.fetch(url, { signal: ctl.signal });
            if (!r.ok) { this.logger.warn?.('geocode: ответ ' + r.status); return { ok: false, code: 'GEOCODER_FAILED' }; }   // ошибки не кэшируем
            const j = await r.json();
            const m = j && j.response && j.response.GeoObjectCollection && j.response.GeoObjectCollection.featureMember[0];
            const pos = m ? String(m.GeoObject.Point.pos).split(' ').map(Number) : null;
            value = pos && Number.isFinite(pos[0]) && Number.isFinite(pos[1])
                ? { ok: true, lat: pos[1], lng: pos[0], name: String(m.GeoObject.name || '').slice(0, 120) }
                : { ok: false, code: 'NOT_FOUND' };            // «не найдено» кэшируем: повтор не поможет
        } catch (e) {
            return { ok: false, code: e && e.name === 'AbortError' ? 'GEOCODER_TIMEOUT' : 'GEOCODER_FAILED' };
        } finally { clearTimeout(timer); }

        if (this.cache.size >= this.maxEntries) this.cache.delete(this.cache.keys().next().value);   // вытесняем самый старый
        this.cache.set(q, { at: this.now(), value });
        return value;
    }
}

module.exports = { Geocoder };
