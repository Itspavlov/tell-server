'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { WeatherStore } = require('../src/weather');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { makeCfg, makeStore, makeIo, limiters, silent, tmpDir } = require('./helpers');

const okJson = (body) => async () => ({ ok: true, json: async () => body });
function fakeFetch({ air = 14.26, water = 17.8, failAir = false, failWater = false } = {}) {
    return async (url) => {
        if (url.includes('marine')) {
            if (failWater) throw new Error('сеть');
            return { ok: true, json: async () => ({ current: { sea_surface_temperature: water } }) };
        }
        if (failAir) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, json: async () => ({ current: { temperature_2m: air } }) };
    };
}
async function make(over = {}) {
    let t = 1_000_000;
    const w = new WeatherStore({ dataDir: tmpDir(), logger: silent, fetchImpl: fakeFetch(over), now: () => t });
    await w.init();
    return { w, tick: (ms) => { t += ms; }, dir: w.file.file };
}

test('до первой загрузки погода скрыта, после загрузки округляется до десятых', async () => {
    const { w } = await make();
    assert.deepEqual(w.current(), { air: null, water: null, updatedAt: null });
    await w.refresh();
    assert.equal(w.current().air, 14.3);
    assert.equal(w.current().water, 17.8);
});

test('сбой одного источника не стирает второй и прежнее значение', async () => {
    const { w } = await make();
    await w.refresh();
    w.fetch = fakeFetch({ air: 20, failWater: true });
    await w.refresh();
    assert.equal(w.current().air, 20);
    assert.equal(w.current().water, 17.8);   // осталось прежнее
    w.fetch = fakeFetch({ failAir: true, failWater: true });
    await w.refresh();
    assert.equal(w.current().air, 20);
});

test('автоданные старше 3 часов не показываются', async () => {
    const { w, tick } = await make();
    await w.refresh();
    tick(3 * 3600 * 1000 + 1);
    assert.equal(w.current().air, null);
    assert.equal(w.current().water, null);
});

test('мусор из API (не число, вне диапазона) отбрасывается', async () => {
    const { w } = await make({ air: 'тепло', water: 99 });
    await w.refresh();
    assert.deepEqual([w.current().air, w.current().water], [null, null]);
});

test('ручной режим держится сколько угодно и важнее автоданных; off скрывает', async () => {
    const { w, tick } = await make();
    await w.refresh();
    assert.equal((await w.update({ water: { mode: 'manual', manual: 16 } })).ok, true);
    tick(10 * 3600 * 1000);
    assert.equal(w.current().water, 16);
    assert.equal(w.current().air, null);   // автоданные устарели
    await w.update({ water: { mode: 'off' } });
    assert.equal(w.current().water, null);
    await w.update({ water: { mode: 'auto' } });
    assert.equal(w.current().water, null);  // ручное число запомнено, но автоданные устарели
});

test('проверка ввода админа', async () => {
    const { w } = await make();
    assert.equal((await w.update({ air: { mode: 'manual' } })).ok, false);                  // нет числа
    assert.equal((await w.update({ air: { mode: 'manual', manual: 99 } })).ok, false);       // вне диапазона
    assert.equal((await w.update({ water: { mode: 'manual', manual: 'abc' } })).ok, false);
    assert.equal((await w.update({ air: { mode: 'hot' } })).ok, false);
    assert.equal((await w.update({ air: 5 })).ok, false);
    assert.equal((await w.update({ air: { mode: 'manual', manual: -3 } })).ok, true);
    assert.equal(w.current().air, -3);
});

test('настройки переживают перезапуск', async () => {
    const dir = tmpDir();
    const a = new WeatherStore({ dataDir: dir, logger: silent, fetchImpl: fakeFetch() });
    await a.init(); await a.refresh();
    await a.update({ air: { mode: 'manual', manual: 12.5 }, water: { mode: 'off' } });
    const b = new WeatherStore({ dataDir: dir, logger: silent, fetchImpl: fakeFetch() });
    await b.init();
    assert.equal(b.current().air, 12.5);
    assert.equal(b.current().water, null);
    assert.equal(b.settings().water.mode, 'off');
});

// ---------- HTTP ----------
const TOKEN = crypto.randomBytes(32).toString('hex');
function res() {
    const r = { code: 200, headers: {}, body: undefined };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.set = (k, v) => { r.headers[k] = v; return r; };
    return r;
}
const req = (o = {}) => ({ ip: '1.1.1.1', params: {}, query: {}, headers: {}, ...o });
async function http() {
    const cfg = makeCfg({ env: { ADMIN_TOKEN: TOKEN } });
    const store = await makeStore(cfg);
    const admin = createAdmin({ token: cfg.adminToken, dataDir: cfg.dataDir, logger: silent });
    const { w } = await make();
    const h = createHandlers({ cfg, store, admin, weather: w, limiters: limiters(cfg), io: makeIo(), logger: silent });
    return { h, w, store };
}
const auth = { authorization: 'Bearer ' + TOKEN };

test('публичный /api/weather отдаёт значения и кэшируется', async () => {
    const { h, w, store } = await http();
    await w.refresh();
    const r = res(); h.weatherGet(req(), r);
    assert.equal(r.body.ok, true); assert.equal(r.body.air, 14.3);
    assert.match(r.headers['Cache-Control'], /max-age/);
    await store.close();
});

test('админка погоды: без токена 401, с токеном читает и меняет', async () => {
    const { h, w, store } = await http();
    let r = res(); await h.adminWeatherGet(req(), r); assert.equal(r.code, 401);
    r = res(); await h.adminWeatherSet(req({ body: { air: { mode: 'manual', manual: 30 } } }), r); assert.equal(r.code, 401);
    assert.equal(w.current().air, null);
    r = res(); await h.adminWeatherSet(req({ headers: auth, body: { air: { mode: 'manual', manual: 30 } } }), r);
    assert.equal(r.code, 200); assert.equal(r.body.air.shown, 30);
    r = res(); await h.adminWeatherSet(req({ headers: auth, body: { air: { mode: 'manual', manual: 300 } } }), r);
    assert.equal(r.code, 400);
    r = res(); await h.adminWeatherRefresh(req({ headers: auth }), r);
    assert.equal(r.code, 200); assert.equal(r.body.water.auto, 17.8);
    await store.close();
});

test('без модуля погоды маршруты отвечают 404', async () => {
    const cfg = makeCfg({ env: { ADMIN_TOKEN: TOKEN } });
    const store = await makeStore(cfg);
    const admin = createAdmin({ token: cfg.adminToken, dataDir: cfg.dataDir, logger: silent });
    const h = createHandlers({ cfg, store, admin, limiters: limiters(cfg), io: makeIo(), logger: silent });
    const r = res(); h.weatherGet(req(), r); assert.equal(r.code, 404);
    await store.close();
});
