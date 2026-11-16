'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Geocoder } = require('../src/geocode');

const yaBody = (lng, lat, name) => ({ response: { GeoObjectCollection: { featureMember: [{ GeoObject: { name, Point: { pos: lng + ' ' + lat } } }] } } });
const okFetch = (calls) => async (url) => { calls.push(url); return { ok: true, json: async () => yaBody(38.53, 44.36, 'улица Ленина, 1') }; };

test('находит адрес, прячет ключ на сервере, кэширует на 24 часа', async () => {
    const calls = []; let t = 1000;
    const g = new Geocoder({ apiKey: 'KEY', fetchImpl: okFetch(calls), now: () => t });
    const a = await g.find('  Ленина 1 ');
    assert.deepEqual(a, { ok: true, lat: 44.36, lng: 38.53, name: 'улица Ленина, 1' });
    assert.match(calls[0], /apikey=KEY/); assert.match(decodeURIComponent(calls[0]), /архипо-осиповка, ленина 1/);
    await g.find('ЛЕНИНА   1'); assert.equal(calls.length, 1);                 // тот же запрос после нормализации — из кэша
    t += 25 * 60 * 60 * 1000; await g.find('ленина 1'); assert.equal(calls.length, 2);   // кэш истёк
});

test('плохой запрос, выключенный геокодер, ошибки и таймаут', async () => {
    assert.equal((await new Geocoder({ apiKey: 'K', fetchImpl: okFetch([]) }).find('я')).code, 'BAD_QUERY');
    assert.equal((await new Geocoder({ apiKey: '', fetchImpl: okFetch([]) }).find('ленина')).code, 'GEOCODER_OFF');
    let n = 0;
    const bad = new Geocoder({ apiKey: 'K', logger: {}, fetchImpl: async () => { n++; return { ok: false, status: 403 }; } });
    assert.equal((await bad.find('ленина')).code, 'GEOCODER_FAILED');
    await bad.find('ленина'); assert.equal(n, 2);                               // ошибки не кэшируются
    const empty = new Geocoder({ apiKey: 'K', fetchImpl: async () => ({ ok: true, json: async () => ({ response: { GeoObjectCollection: { featureMember: [] } } }) }) });
    assert.equal((await empty.find('несуществующая')).code, 'NOT_FOUND');
    const slow = new Geocoder({ apiKey: 'K', timeoutMs: 20, fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => { const e = new Error('a'); e.name = 'AbortError'; rej(e); })) });
    assert.equal((await slow.find('ленина')).code, 'GEOCODER_TIMEOUT');
});


test('ключ, ограниченный по сайту: сервер шлёт Referer', async () => {
    let seen = null;
    const g = new Geocoder({ apiKey: 'K', referer: 'https://example.test/', fetchImpl: async (u, o) => { seen = o.headers; return { ok: true, json: async () => yaBody(38.5, 44.3, 'x') }; } });
    await g.find('ленина 1');
    assert.equal(seen.Referer, 'https://example.test/');
    seen = null;
    await new Geocoder({ apiKey: 'K', fetchImpl: async (u, o) => { seen = o.headers; return { ok: true, json: async () => yaBody(38.5, 44.3, 'x') }; } }).find('ленина 1');
    assert.equal('Referer' in seen, false);
});

// ---- HTTP-обработчик ----
const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
const { createHandlers } = require('../src/http');
const { makeCfg, makeIo, limiters, silent } = require('./helpers');
const mkRes = () => ({ code: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

test('GET /api/geocode: ответ без ключа, лимит 10 в минуту на IP, выключенный геокодер — 404', async () => {
    const cfg = makeCfg();
    const geocoder = new Geocoder({ apiKey: 'SECRET-KEY', fetchImpl: okFetch([]) });
    const h = createHandlers({ cfg, store: {}, admin: {}, accounts: {}, listings: {}, geocoder, limiters: limiters(cfg), io: makeIo(), logger: silent });
    let r = mkRes(); await h.geocodeGet({ ip: '1.2.3.4', query: { q: 'ленина 1' } }, r);
    assert.equal(r.code, 200); assert.equal(r.body.ok, true); assert.equal(r.body.lat, 44.36);
    assert.equal(JSON.stringify(r.body).includes('SECRET'), false);
    r = mkRes(); await h.geocodeGet({ ip: '1.2.3.4', query: { q: 'я' } }, r); assert.equal(r.code, 400);
    for (let i = 0; i < 8; i++) { r = mkRes(); await h.geocodeGet({ ip: '1.2.3.4', query: { q: 'ленина 1' } }, r); }
    assert.equal(r.code, 200);
    r = mkRes(); await h.geocodeGet({ ip: '1.2.3.4', query: { q: 'ленина 1' } }, r); assert.equal(r.code, 429);
    r = mkRes(); await h.geocodeGet({ ip: '5.6.7.8', query: { q: 'ленина 1' } }, r); assert.equal(r.code, 200);   // другой IP — свой лимит
    const off = createHandlers({ cfg, store: {}, admin: {}, accounts: {}, listings: {}, geocoder: new Geocoder({ apiKey: '' }), limiters: limiters(cfg), io: makeIo(), logger: silent });
    r = mkRes(); await off.geocodeGet({ ip: '9.9.9.9', query: { q: 'ленина 1' } }, r); assert.equal(r.code, 404);
});
