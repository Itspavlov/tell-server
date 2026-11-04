'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const { createHandlers, createApp } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { makeCfg, makeStore, makeIo, limiters, silent } = require('./helpers');

const TOKEN = crypto.randomBytes(32).toString('hex');

async function setup(withAdmin = true) {
    const cfg = makeCfg({ env: withAdmin ? { ADMIN_TOKEN: TOKEN } : {} });
    const store = await makeStore(cfg);
    const io = makeIo();
    const admin = createAdmin({ token: cfg.adminToken, dataDir: cfg.dataDir, logger: silent });
    const lim = limiters(cfg);
    const h = createHandlers({ cfg, store, admin, limiters: lim, io, logger: silent });
    return { cfg, store, io, admin, lim, h };
}
function res() {
    const r = { code: 200, headers: {}, body: undefined, headersSent: false };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.set = (k, v) => { r.headers[k] = v; return r; };
    return r;
}
const req = (o = {}) => ({ ip: '1.1.1.1', params: {}, query: {}, headers: {}, ...o });
const m = (i) => ({ id: 'm' + i, user: 'Тарас', text: 't' + i, avatar: 'Т', image: null, time: i });

test('DELETE без токена -> 401, история цела', async () => {
    const { h, store, io } = await setup();
    await store.append('housing', m(1));
    const r = res();
    await h.clearRoom(req({ params: { room: 'housing' } }), r);
    assert.equal(r.code, 401);
    assert.equal(store.stats().rooms.housing, 1);
    assert.equal(io.emitted.length, 0);
    await store.close();
});

test('DELETE с неверным токеном -> 401 и запись в аудит без токена', async () => {
    const { h, store, admin } = await setup();
    const r = res();
    await h.clearRoom(req({ params: { room: 'housing' }, headers: { authorization: 'Bearer ' + 'a'.repeat(40) } }), r);
    assert.equal(r.code, 401);
    const log = fs.readFileSync(admin.auditFile, 'utf-8');
    assert.match(log, /admin_denied/);
    assert.equal(log.includes('a'.repeat(40)), false);
    await store.close();
});

test('DELETE с верным токеном очищает, пишет аудит, шлёт room-cleared', async () => {
    const { h, store, io, admin } = await setup();
    await store.append('housing', m(1));
    const r = res();
    await h.clearRoom(req({ params: { room: 'housing' }, headers: { authorization: 'Bearer ' + TOKEN } }), r);
    assert.equal(r.code, 200);
    assert.equal(store.stats().rooms.housing, 0);
    assert.equal(io.emitted[0].ev, 'room-cleared');
    assert.match(fs.readFileSync(admin.auditFile, 'utf-8'), /clear_room/);
    await store.close();
});

test('без ADMIN_TOKEN админ-маршруты выглядят как несуществующие (404), даже с любым токеном', async () => {
    const { h, store } = await setup(false);
    await store.append('housing', m(1));
    const r = res();
    await h.clearRoom(req({ params: { room: 'housing' }, headers: { authorization: 'Bearer anything' } }), r);
    assert.equal(r.code, 404);
    const r2 = res();
    await h.exportAll(req(), r2);
    assert.equal(r2.code, 404);
    assert.equal(store.stats().rooms.housing, 1);
    await store.close();
});

test('перебор токена ограничивается (10 попыток в минуту)', async () => {
    const { h, store } = await setup();
    const codes = [];
    for (let i = 0; i < 13; i++) { const r = res(); await h.clearRoom(req({ params: { room: 'housing' }, headers: { authorization: 'Bearer x' + i } }), r); codes.push(r.code); }
    assert.equal(codes.filter(c => c === 429).length, 3);
    await store.close();
});

test('export: только с токеном', async () => {
    const { h, store } = await setup();
    await store.append('work', m(1));
    const bad = res(); await h.exportAll(req(), bad); assert.equal(bad.code, 401);
    const ok = res(); await h.exportAll(req({ headers: { authorization: 'Bearer ' + TOKEN } }), ok);
    assert.equal(ok.code, 200);
    assert.equal(ok.body.work.length, 1);
    await store.close();
});

test('история: формат совместим, лимит, before, неверная комната', async () => {
    const { h, store } = await setup();
    for (let i = 0; i < 30; i++) await store.append('housing', m(i));
    const r = res(); h.history(req({ params: { room: 'housing' }, query: { limit: '10' } }), r);
    assert.equal(r.body.room, 'housing');
    assert.equal(r.body.count, 10);
    assert.equal(r.body.hasMore, true);
    const r2 = res(); h.history(req({ params: { room: 'housing' }, query: { limit: '10', before: r.body.nextBefore } }), r2);
    assert.equal(r2.body.messages[9].id, 'm19');
    const r3 = res(); h.history(req({ params: { room: 'housing' }, query: { limit: '99999' } }), r3);
    assert.equal(r3.body.count, 30);
    const r4 = res(); h.history(req({ params: { room: 'secret' } }), r4);
    assert.equal(r4.code, 404);
    const r5 = res(); h.history(req({ params: { room: '__proto__' } }), r5);
    assert.equal(r5.code, 404);
    await store.close();
});

test('история: лимит запросов 60/мин', async () => {
    const { h, store } = await setup();
    let blocked = 0;
    for (let i = 0; i < 65; i++) { const r = res(); h.history(req({ params: { room: 'work' } }), r); if (r.code === 429) { blocked++; assert.ok(r.headers['Retry-After']); } }
    assert.equal(blocked, 5);
    await store.close();
});

test('healthz всегда ok; readyz 503 после сбоя записи', async () => {
    const { h, store } = await setup();
    const a = res(); h.healthz(req(), a); assert.equal(a.body.ok, true);
    const b = res(); h.readyz(req(), b); assert.equal(b.code, 200);
    store.lastWriteOk = false;
    const c = res(); h.readyz(req(), c); assert.equal(c.code, 503);
    await store.close();
});

test('корень: прежние поля status/rooms/totalMessages', async () => {
    const { h, store } = await setup();
    const r = res(); h.root(req(), r);
    assert.equal(r.body.status, 'ok');
    assert.deepEqual(r.body.rooms, ['housing', 'work', 'market', 'trips']);
    assert.equal(r.body.totalMessages, 0);
    await store.close();
});

test('заголовки безопасности и обработчик ошибок не раскрывает детали', async () => {
    const { h, store } = await setup();
    const r = res(); let called = false; h.security(req(), r, () => { called = true; });
    assert.ok(called);
    assert.equal(r.headers['X-Content-Type-Options'], 'nosniff');
    const e = res(); h.onError(new Error('secret path /etc/passwd'), req(), e, () => {});
    assert.equal(e.code, 500);
    assert.equal(JSON.stringify(e.body).includes('passwd'), false);
    await store.close();
});

test('createApp подключает маршруты (проверка на поддельном express)', async () => {
    const { cfg, store, admin, lim, io } = await setup();
    const routes = [];
    const app = { set() {}, disable() {}, use(...a) { routes.push(['use', a.length]); }, get(p) { routes.push(['GET', p]); }, post(p) { routes.push(['POST', p]); }, delete(p) { routes.push(['DELETE', p]); } };
    const fakeExpress = () => app; fakeExpress.json = () => (q, r, n) => n();
    createApp({ express: fakeExpress, cors: () => (q, s, n) => n(), cfg, store, admin, limiters: lim, io, logger: silent });
    const have = routes.filter(r => r[0] !== 'use').map(r => r.join(' '));
    for (const need of ['GET /healthz', 'GET /readyz', 'GET /', 'GET /api/messages/:room', 'DELETE /api/messages/:room', 'GET /api/admin/export', 'POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/logout', 'GET /api/auth/me']) {
        assert.ok(have.includes(need), need);
    }
    await store.close();
});
