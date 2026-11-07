'use strict';
// ============================================
// Просмотры объявлений (для кабинета хозяина).
//  • один человек (аккаунт или IP) считается раз в сутки на объявление;
//  • свои просмотры хозяина не считаются;
//  • защита от повторов держится в памяти, после перезапуска сервера
//    в тот же день один человек может быть засчитан ещё раз;
//  • запись на диск откладывается на несколько секунд и делается при остановке.
// ============================================
const path = require('path');
const { JsonFile } = require('./jsonfile');

const KEEP_DAYS = 60, FLUSH_MS = 10_000;

class StatsStore {
    constructor({ dataDir, now = Date.now, logger = console, fsImpl }) {
        this.file = new JsonFile({ file: path.join(dataDir, 'stats.json'), fsImpl });
        this.now = now; this.logger = logger;
        this.data = { views: {} };
        this.seen = new Set(); this.seenDay = '';
        this.timer = null; this.dirty = false;
    }

    async init() { const d = await this.file.load({}); this.data = { views: d.views || {} }; }

    _day(t = this.now()) { return new Date(t + 3 * 3600_000).toISOString().slice(0, 10); }   // сутки по Москве

    view(listingId, viewerKey) {
        const day = this._day();
        if (day !== this.seenDay) { this.seen.clear(); this.seenDay = day; }
        const k = listingId + '|' + viewerKey;
        if (this.seen.has(k)) return false;
        if (this.seen.size > 200_000) this.seen.clear();
        this.seen.add(k);
        const v = this.data.views[listingId] || (this.data.views[listingId] = { t: 0, d: {} });
        v.t++; v.d[day] = (v.d[day] || 0) + 1;
        const days = Object.keys(v.d);
        if (days.length > KEEP_DAYS) for (const o of days.sort().slice(0, days.length - KEEP_DAYS)) delete v.d[o];
        this._schedule();
        return true;
    }

    _schedule() {
        this.dirty = true;
        if (this.timer) return;
        this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, FLUSH_MS);
        if (this.timer.unref) this.timer.unref();
    }

    async flush() {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (!this.dirty) return;
        this.dirty = false;
        try { await this.file.save(this.data); }
        catch (e) { this.dirty = true; this.logger.error('stats save failed', e.message); }
    }

    // { total, week, series: [7 чисел, от старых к новым] }
    summary(listingId) {
        const v = this.data.views[listingId];
        const series = [];
        for (let i = 6; i >= 0; i--) series.push(v ? (v.d[this._day(this.now() - i * 86400_000)] || 0) : 0);
        return { total: v ? v.t : 0, week: series.reduce((a, b) => a + b, 0), series };
    }

    drop(listingId) { if (this.data.views[listingId]) { delete this.data.views[listingId]; this._schedule(); } }
}

module.exports = { StatsStore };
