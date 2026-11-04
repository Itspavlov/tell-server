'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { AccountStore, nameKey } = require('../src/accounts');
const { ListingStore } = require('../src/listings');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { makeCfg, makeStore, makeIo, limiters, silent, PNG } = require('./helpers');

const PW = 'correct horse 9';
const TOKEN = 'b'.repeat(40);
const AH = { authorization: 'Bearer ' + TOKEN };
const res = () => { const r = { code: 200, body: null, headers: {} }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.set = (k, v) => { r.headers[k] = v; return r; }; r.send = b => { r.body = b; return r; }; return r; };
const req = (o = {}) => ({ ip: '5.5.5.5', params: {}, query: {}, headers: {}, body: {}, ...o });

async function setup(adminToken = TOKEN) {
    const cfg = makeCfg();
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const listings = new ListingStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger: silent }); await listings.init();
    const store = await makeStore(cfg);
    const io = makeIo();
    const admin = createAdmin({ token: adminToken, dataDir: cfg.dataDir, logger: silent });
    const lim = limiters(cfg);
    const h = createHandlers({ cfg, store, admin, accounts, listings, limiters: lim, io, logger: silent });
    return { cfg, accounts, listings, store, io, h, lim };
}
const msg = (user, text, id) => ({ id, user, text, time: Date.now(), avatar: '' });

test('модерация: без токена и с чужим токеном доступа нет ни к чему', async () => {
    const { h, store } = await setup();
    const calls = [
        () => h.adminOverview, () => h.adminMessages, () => h.adminDeleteMessage, () => h.adminPurgeUser,
        () => h.adminUsers, () => h.adminBan, () => h.adminVerifyReject, () => h.adminListings, () => h.adminDeleteListing, () => h.adminAudit
    ].map(f => f());
    let n = 0;
    for (const fn of calls) {
        for (const headers of [{}, { authorization: 'Bearer wrong' }]) {
            const r = res(); await fn(req({ ip: '7.7.' + (++n >> 8) + '.' + (n & 255), headers, params: { room: 'housing', id: 'x' }, body: { name: 'a', banned: true } }), r);
            assert.equal(r.code, 401);
        }
    }
    await store.close();
});

test('модерация: админка выключена, если ADMIN_TOKEN не задан (в том числе страница)', async () => {
    const { h, store } = await setup('');
    let r = res(); await h.adminUsers(req({ headers: AH }), r);
    assert.equal(r.code, 404);
    r = res(); h.panel('html')(req(), r);
    assert.equal(r.code, 404);
    await store.close();
});

test('модерация: подбор токена блокируется после 10 неудач, верный токен тоже не пускает', async () => {
    const { h, store } = await setup();
    for (let i = 0; i < 10; i++) { const r = res(); await h.adminOverview(req({ headers: { authorization: 'Bearer nope' + i } }), r); assert.equal(r.code, 401); }
    const r = res(); await h.adminOverview(req({ headers: AH }), r);
    assert.equal(r.code, 429);
    const other = res(); await h.adminOverview(req({ ip: '9.9.9.9', headers: AH }), other);
    assert.equal(other.code, 200, 'другой адрес не пострадал');
    await store.close();
});

test('модерация: удалить сообщение — исчезает из истории, всем в комнате уходит событие, пишется аудит', async () => {
    const { h, store, io, cfg } = await setup();
    await store.append('housing', msg('Спамер', 'купи крипту', 'm1'));
    await store.append('housing', msg('Аня', 'привет', 'm2'));
    let r = res(); await h.adminDeleteMessage(req({ headers: AH, params: { room: 'housing', id: 'm1' } }), r);
    assert.equal(r.code, 200);
    assert.deepEqual(store.getHistory('housing').messages.map(m => m.id), ['m2']);
    assert.ok(io.emitted.some(e => e.room === 'housing' && e.ev === 'message-deleted' && e.payload.id === 'm1'));
    r = res(); await h.adminDeleteMessage(req({ headers: AH, params: { room: 'housing', id: 'm1' } }), r);
    assert.equal(r.code, 404);
    r = res(); await h.adminDeleteMessage(req({ headers: AH, params: { room: 'nope', id: 'm1' } }), r);
    assert.equal(r.code, 404);
    const log = fs.readFileSync(path.join(cfg.dataDir, 'audit.log'), 'utf-8');
    assert.ok(log.includes('"action":"delete_message"') && log.includes('Спамер'));
    assert.equal(log.includes('купи крипту'), false, 'текст сообщений в журнал не попадает');
    await store.close();
});

test('модерация: удаление переживает перезапуск', async () => {
    const { store, cfg } = await setup();
    await store.append('work', msg('X', 'a', 'w1'));
    await store.append('work', msg('Y', 'b', 'w2'));
    await store.removeMessage('work', 'w1');
    await store.close();
    const again = await makeStore(cfg);
    assert.deepEqual(again.getHistory('work').messages.map(m => m.id), ['w2']);
    await again.close();
});

test('модерация: «стереть автора» чистит все комнаты, регистр имени не важен', async () => {
    const { h, store, io } = await setup();
    await store.append('housing', msg('Спамер', '1', 's1'));
    await store.append('work', msg('спамер', '2', 's2'));
    await store.append('work', msg('Аня', '3', 'a1'));
    let r = res(); await h.adminPurgeUser(req({ headers: AH, body: { name: 'СПАМЕР' } }), r);
    assert.equal(r.code, 200); assert.equal(r.body.removed, 2);
    assert.equal(store.getHistory('housing').messages.length, 0);
    assert.deepEqual(store.getHistory('work').messages.map(m => m.id), ['a1']);
    assert.equal(io.emitted.filter(e => e.ev === 'message-deleted').length, 2);
    r = res(); await h.adminPurgeUser(req({ headers: AH, body: {} }), r);
    assert.equal(r.code, 400);
    await store.close();
});

test('модерация: блокировка — сессия сбрасывается, вход закрыт, разблокировка возвращает', async () => {
    const { h, accounts, store } = await setup();
    const u = await accounts.register('Хулиган', PW);
    assert.ok(accounts.authenticate(u.token));
    let r = res(); await h.adminBan(req({ headers: AH, body: { name: 'хулиган', banned: true } }), r);
    assert.equal(r.code, 200);
    assert.equal(accounts.authenticate(u.token), null);
    assert.equal((await accounts.login('Хулиган', PW)).code, 'BANNED');
    assert.equal(accounts.listUsers('хул')[0].banned, true);
    r = res(); await h.adminBan(req({ headers: AH, body: { name: 'Нет такого', banned: true } }), r);
    assert.equal(r.code, 404);
    r = res(); await h.adminBan(req({ headers: AH, body: { name: 'Хулиган' } }), r);
    assert.equal(r.code, 400);
    r = res(); await h.adminBan(req({ headers: AH, body: { name: 'Хулиган', banned: false } }), r);
    assert.equal(r.code, 200);
    assert.equal((await accounts.login('Хулиган', PW)).ok, true);
    await store.close();
});

test('модерация: блокировка переживает перезапуск', async () => {
    const { accounts, cfg, store } = await setup();
    await accounts.register('Бан', PW);
    await accounts.setBanned(nameKey('Бан'), true);
    const a2 = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await a2.init();
    assert.equal((await a2.login('Бан', PW)).code, 'BANNED');
    await store.close();
});

test('модерация: заявки — отклонить убирает заявку, не выдавая статус', async () => {
    const { h, accounts, store } = await setup();
    const u = await accounts.register('Хозяин', PW);
    await accounts.requestVerification(accounts.authenticate(u.token).id, 'сдаю');
    let r = res(); await h.adminVerifyReject(req({ headers: AH, body: { name: 'Хозяин' } }), r);
    assert.equal(r.code, 200);
    assert.equal(accounts.listVerifyRequests().length, 0);
    assert.equal(accounts.findByKey(nameKey('Хозяин')).verified, false);
    r = res(); await h.adminVerifyReject(req({ headers: AH, body: { name: 'Хозяин' } }), r);
    assert.equal(r.code, 404);
    r = res(); await h.adminOverview(req({ headers: AH }), r);
    assert.equal(r.body.users.users, 1);
    await store.close();
});

test('модерация: объявления — список с владельцами, удаление чужого, оповещение всех', async () => {
    const { h, accounts, listings, store, io } = await setup();
    const u = await accounts.register('Хозяйка', PW);
    await accounts.setVerified(nameKey('Хозяйка'), true);
    const user = accounts.authenticate(u.token);
    const AD = { type: 'rent', title: 'Студия', priceNum: 3000, price: '3 000 ₽', location: 'Анапа', description: 'x', photos: [PNG], thumb: PNG, facts: [], amenities: [], terms: [], rules: [], coords: [44.9, 37.3], beach: [44.8, 37.3], busy: [], form: {} };
    const saved = await listings.save(user, { ad: AD, profile: { phone: '+7 900', about: '', avatar: '' } });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    let r = res(); await h.adminListings(req({ headers: AH }), r);
    assert.equal(r.body.listings.length, 1);
    assert.equal(r.body.listings[0].ownerName, 'Хозяйка');
    const id = r.body.listings[0].id;
    r = res(); await h.adminDeleteListing(req({ headers: AH, params: { id } }), r);
    assert.equal(r.code, 200);
    assert.equal(listings.get(id), null);
    assert.ok(io.emitted.some(e => e.ev === 'listing-changed' && e.payload.id === id));
    r = res(); await h.adminDeleteListing(req({ headers: AH, params: { id } }), r);
    assert.equal(r.code, 404);
    await store.close();
});

test('модерация: журнал читается новыми сверху и без секретов', async () => {
    const { h, store, cfg } = await setup();
    let r = res(); await h.adminUsers(req({ headers: { authorization: 'Bearer bad' } }), r);
    r = res(); await h.adminVerify(req({ headers: AH, body: { name: 'нет', verified: true } }), r);
    r = res(); await h.adminAudit(req({ headers: AH }), r);
    assert.equal(r.code, 200);
    assert.ok(r.body.entries.length >= 1);
    assert.ok(r.body.entries.some(e => e.action === 'admin_denied'));
    assert.equal(JSON.stringify(r.body).includes(TOKEN), false);
    await store.close();
});

test('страница панели: отдаётся с жёсткой CSP, без внешних скриптов и без инлайна', async () => {
    const { h, store } = await setup();
    for (const [k, type] of [['html', 'text/html'], ['js', 'javascript'], ['css', 'text/css']]) {
        const r = res(); h.panel(k)(req(), r);
        assert.equal(r.code, 200);
        assert.ok(r.headers['Content-Type'].includes(type));
        assert.ok(r.headers['Content-Security-Policy'].includes("script-src 'self'"));
        assert.ok(!r.headers['Content-Security-Policy'].includes('unsafe-inline'));
        assert.equal(r.headers['X-Frame-Options'], 'DENY');
    }
    const r = res(); h.panel('html')(req(), r);
    assert.ok(!/<script(?![^>]*src=)/.test(r.body), 'нет инлайн-скриптов');
    assert.ok(!/innerHTML/.test(require('../src/adminPage').js.body), 'панель не использует innerHTML');
    await store.close();
});
