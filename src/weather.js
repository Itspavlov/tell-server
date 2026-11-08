'use strict';
// ============================================
// Погода в шапке приложения: температура воздуха и воды.
//
// По умолчанию берётся автоматически (Open-Meteo, бесплатно, без ключа) раз в 30 минут.
// В админке любое значение можно задать вручную или скрыть:
//   auto   — автоматически (если данные старше 3 часов, значение скрывается)
//   manual — число, заданное админом, остаётся пока его не сменят
//   off    — не показывать
// Если автоматические данные не загрузились, показывается последнее удачное значение
// не дольше 3 часов, потом значение скрывается, а не врёт.
// ============================================

const path = require('path');
const { JsonFile } = require('./jsonfile');
const { fail } = require('./validate');

const MODES = ['auto', 'manual', 'off'];
const LIMITS = { air: [-40, 60], water: [-3, 40] };
const STALE_MS = 3 * 3600 * 1000;

// Архипо-Осиповка и точка в море напротив (для морского прогноза)
const PLACE = { lat: 44.3667, lon: 38.5333, seaLat: 44.34, seaLon: 38.48 };

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

class WeatherStore {
    constructor({ dataDir, logger = console, fsImpl, fetchImpl = globalThis.fetch, now = Date.now, place = PLACE, timeoutMs = 8000 }) {
        this.file = new JsonFile({ file: path.join(dataDir, 'weather.json'), fsImpl });
        this.logger = logger;
        this.fetch = fetchImpl;
        this.now = now;
        this.place = place;
        this.timeoutMs = timeoutMs;
        this.data = this.blank();
    }

    blank() {
        return { air: { mode: 'auto', manual: null }, water: { mode: 'auto', manual: null }, auto: { air: null, water: null, airTs: 0, waterTs: 0 } };
    }

    async init() {
        const d = await this.file.load({});
        const b = this.blank();
        for (const k of ['air', 'water']) {
            const s = d[k] || {};
            b[k].mode = MODES.includes(s.mode) ? s.mode : 'auto';
            b[k].manual = num(s.manual);
            const a = d.auto || {};
            b.auto[k] = num(a[k]);
            b.auto[k + 'Ts'] = Number(a[k + 'Ts']) || 0;
        }
        this.data = b;
    }

    value(kind) {
        const s = this.data[kind];
        if (s.mode === 'off') return null;
        if (s.mode === 'manual') return s.manual;
        const v = this.data.auto[kind];
        const ts = this.data.auto[kind + 'Ts'];
        return v !== null && this.now() - ts < STALE_MS ? v : null;
    }

    // Что видят посетители
    current() {
        const ts = Math.max(this.data.auto.airTs, this.data.auto.waterTs);
        return { air: this.value('air'), water: this.value('water'), updatedAt: ts || null };
    }

    // Что видит админ: настройки и то, что принесла автоматика
    settings() {
        return {
            air: { ...this.data.air, auto: this.data.auto.air, autoAt: this.data.auto.airTs || null, shown: this.value('air') },
            water: { ...this.data.water, auto: this.data.auto.water, autoAt: this.data.auto.waterTs || null, shown: this.value('water') },
            limits: LIMITS
        };
    }

    async update(raw) {
        const b = raw && typeof raw === 'object' ? raw : {};
        const next = { air: { ...this.data.air }, water: { ...this.data.water } };
        for (const kind of ['air', 'water']) {
            const s = b[kind];
            if (s === undefined) continue;
            if (!s || typeof s !== 'object' || !MODES.includes(s.mode)) return fail('BAD_PAYLOAD');
            next[kind].mode = s.mode;
            if (s.manual !== undefined && s.manual !== null && s.manual !== '') {
                const v = Number(s.manual);
                if (!Number.isFinite(v) || v < LIMITS[kind][0] || v > LIMITS[kind][1]) return fail('BAD_PAYLOAD', { message: `Температура ${kind === 'air' ? 'воздуха' : 'воды'}: от ${LIMITS[kind][0]} до ${LIMITS[kind][1]}` });
                next[kind].manual = num(v);
            }
            if (s.mode === 'manual' && next[kind].manual === null) return fail('BAD_PAYLOAD', { message: 'Для ручного режима укажите число' });
        }
        const prev = this.data;
        this.data = { ...prev, air: next.air, water: next.water };
        try { await this.file.save(this.data); }
        catch (e) { this.data = prev; return fail('STORE_UNAVAILABLE'); }
        return { ok: true };
    }

    async getJson(url) {
        if (typeof this.fetch !== 'function') throw new Error('fetch недоступен');
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), this.timeoutMs);
        try {
            const r = await this.fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return await r.json();
        } finally { clearTimeout(t); }
    }

    // Берёт свежие значения. Ошибка одного источника не мешает другому и не стирает прежнее значение.
    async refresh() {
        const p = this.place;
        const jobs = [
            ['air', `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&current=temperature_2m&timezone=auto`, (j) => j && j.current && j.current.temperature_2m],
            ['water', `https://marine-api.open-meteo.com/v1/marine?latitude=${p.seaLat}&longitude=${p.seaLon}&current=sea_surface_temperature&timezone=auto`, (j) => j && j.current && j.current.sea_surface_temperature]
        ];
        let changed = false;
        const out = {};
        await Promise.all(jobs.map(async ([kind, url, pick]) => {
            try {
                const v = num(pick(await this.getJson(url)));
                if (v === null || v < LIMITS[kind][0] || v > LIMITS[kind][1]) throw new Error('нет значения');
                this.data.auto[kind] = v; this.data.auto[kind + 'Ts'] = this.now(); changed = true; out[kind] = v;
            } catch (e) { this.logger.warn?.(`Погода (${kind}): ${e.message}`); out[kind] = null; }
        }));
        if (changed) await this.file.save(this.data).catch((e) => this.logger.error?.(`Погода не сохранена: ${e.code || e.message}`));
        return out;
    }
}

module.exports = { WeatherStore, MODES, LIMITS, PLACE };
