'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountStore, nameKey } = require('../src/accounts');
const { ListingStore } = require('../src/listings');
const { RequestStore } = require('../src/requests');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { makeCfg, makeStore, makeIo, limiters, silent } = require('./helpers');

const PW = 'correct horse 9';
const TOKEN = 'c'.repeat(40);
const AH = { authorization: 'Bearer ' + TOKEN };
const res = () => { const r = { code: 200, body: null }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.set = () => r; return r; };
const req = (o = {}) => ({ ip: '6.6.6.6', params: {}, query: {}, headers: {}, body: {}, ...o });
const REQ = (o = {}) => ({ category: 'apartment', city: 'Адлер', dateFrom: '2027-03-15', dateTo: '2027-03-20', guests: 2, budget: 3500, text: 'Ищу квартиру', ...o });

async function setup() {
    const cfg = makeCfg();
    const clock = { t: Date.parse('2027-03-10T12:00:00Z') };
    const now = () => clock.t;
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent, now }); await accounts.init();
    const listings = new ListingStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, now, logger: silent }); await listings.init();
    const requests = new RequestStore({ dataDir: cfg.dataDir, limits: cfg.limits, now, logger: silent }); await requests.init();
    const store = await makeStore(cfg);
    const io = makeIo();
    const admin = createAdmin({ token: TOKEN, dataDir: cfg.dataDir, logger: silent });
    const h = createHandlers({ cfg, store, admin, accounts, listings, requests, limiters: limiters(cfg), io, logger: silent });
    const reg = async (n) => { const u = await accounts.register(n, PW); return { ...accounts.authenticate(u.token), token: u.token }; };
    return { cfg, clock, accounts, requests, store, io, h, reg };
}

test('админ: список и удаление карточек «Ищу» требуют токен', async () => {
    const { h, store } = await setup();
    for (const fn of [h.adminRequests, h.adminDeleteRequest]) {
        const r = res(); await fn(req({ params: { id: 'r_x' } }), r);
        assert.equal(r.code, 401);
    }
    await store.close();
});

test('админ: видит все запросы и удаляет любой, автору уходит уведомление', async () => {
    const { h, store, requests, reg, io } = await setup();
    const a = await reg('Анна');
    const c = await requests.create(a, REQ());
    assert.equal(c.ok, true);
    let r = res(); await h.adminRequests(req({ headers: AH }), r);
    assert.equal(r.body.requests.length, 1);
    assert.equal(r.body.requests[0].ownerName, 'Анна');
    r = res(); await h.adminDeleteRequest(req({ headers: AH, params: { id: c.request.id } }), r);
    assert.equal(r.code, 200);
    assert.equal(requests.get(c.request.id), null);
    assert.ok(io.emitted.some(e => e.ev === 'request-changed' && e.payload.id === c.request.id));
    r = res(); await h.adminDeleteRequest(req({ headers: AH, params: { id: c.request.id } }), r);
    assert.equal(r.code, 404);
    await store.close();
});

test('вход в аккаунт: нужен токен админа и существующий пользователь', async () => {
    const { h, reg, store } = await setup();
    await reg('Борис');
    let r = res(); await h.adminImpersonate(req({ body: { name: 'Борис' } }), r);
    assert.equal(r.code, 401);
    r = res(); await h.adminImpersonate(req({ headers: AH, body: { name: 'Нет такого' } }), r);
    assert.equal(r.code, 404);
    r = res(); await h.adminImpersonate(req({ headers: AH, body: {} }), r);
    assert.equal(r.code, 400);
    r = res(); await h.adminImpersonate(req({ headers: AH, body: { name: 'борис' } }), r);
    assert.equal(r.code, 200);
    assert.equal(r.body.user.name, 'Борис');
    assert.equal(r.body.token.length, 64);
    await store.close();
});

test('режим поддержки: объявления и запросы доступны, переписка и данные аккаунта закрыты', async () => {
    const { h, reg, accounts, store } = await setup();
    const b = await reg('Борис');
    const s = await accounts.startSupport(nameKey('Борис'));
    const H = { authorization: 'Bearer ' + s.token };
    assert.equal(accounts.isSupport(s.token), true);
    assert.equal(accounts.isSupport(b.token), false);
    assert.equal(accounts.authenticate(s.token).support, true);
    const pass = async (method, p) => { let ok = false; await h.supportGuard(req({ method, path: p, headers: H }), res(), () => { ok = true; }); return ok; };
    for (const [m, p] of [['GET', '/auth/me'], ['GET', '/profile'], ['GET', '/listings'], ['POST', '/listings'], ['DELETE', '/listings/abc'],
                          ['GET', '/requests'], ['POST', '/requests/r_1/status'], ['DELETE', '/requests/r_1'], ['POST', '/auth/logout']]) {
        assert.equal(await pass(m, p), true, m + ' ' + p);
    }
    for (const [m, p] of [['GET', '/notifications'], ['POST', '/notifications/read'], ['POST', '/auth/rename'], ['POST', '/auth/verify-request'],
                          ['POST', '/push/subscribe'], ['POST', '/media/video'], ['GET', '/requests/r_1/offers'], ['POST', '/requests/r_1/offers'],
                          ['GET', '/requests/matching'], ['GET', '/requests/r_1/matches'], ['GET', '/anything-else']]) {
        assert.equal(await pass(m, p), false, m + ' ' + p);
    }
    // обычная сессия не ограничивается
    let ok = false; await h.supportGuard(req({ method: 'GET', path: '/notifications', headers: { authorization: 'Bearer ' + b.token } }), res(), () => { ok = true; });
    assert.equal(ok, true);
    await store.close();
});

test('режим поддержки: сессия короткая, настоящие сессии пользователя не вытесняет', async () => {
    const { clock, accounts, reg, store } = await setup();
    const b = await reg('Борис');
    const s = await accounts.startSupport(nameKey('Борис'));
    assert.ok(accounts.authenticate(s.token));
    assert.ok(accounts.authenticate(b.token));
    clock.t += 31 * 60 * 1000;
    assert.equal(accounts.authenticate(s.token), null);
    assert.ok(accounts.authenticate(b.token));
    // забаненного пользователя открыть нельзя
    await accounts.setBanned(nameKey('Борис'), true);
    assert.equal(await accounts.startSupport(nameKey('Борис')), null);
    await store.close();
});
