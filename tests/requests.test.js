'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountStore, nameKey } = require('../src/accounts');
const { ListingStore } = require('../src/listings');
const { RequestStore } = require('../src/requests');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { makeCfg, makeStore, makeIo, limiters, silent, PNG } = require('./helpers');

const PW = 'correct horse 9';
const DAY = 86400000;
async function setup() {
    const cfg = makeCfg();
    const clock = { t: Date.parse('2027-03-10T12:00:00Z') };
    const now = () => clock.t;
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const listings = new ListingStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, now, logger: silent }); await listings.init();
    const requests = new RequestStore({ dataDir: cfg.dataDir, limits: cfg.limits, now, logger: silent }); await requests.init();
    const store = await makeStore(cfg);
    const io = makeIo();
    const admin = createAdmin({ token: '', dataDir: cfg.dataDir, logger: silent });
    const h = createHandlers({ cfg, store, admin, accounts, listings, requests, limiters: limiters(cfg), io, logger: silent });
    const reg = async (n, verified) => { const u = await accounts.register(n, PW); if (verified) await accounts.setVerified(nameKey(n), true); return { ...accounts.authenticate(u.token), token: u.token }; };
    return { cfg, clock, accounts, listings, requests, store, io, h, reg };
}
const res = () => { const r = { code: 200, body: null }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.set = () => r; return r; };
const req = (o = {}) => ({ ip: '4.4.4.4', params: {}, query: {}, headers: {}, body: {}, ...o });
const AD = (n) => ({ type: 'rent', title: 'Студия ' + n, priceNum: 3000, price: '3 000', location: 'Анапа', description: 'x', photos: [PNG], thumb: PNG });
const REQ = (o = {}) => ({ category: 'apartment', city: 'Адлер', dateFrom: '2027-03-15', dateTo: '2027-03-20', guests: 2, budget: 3500, text: 'Ищу квартиру', ...o });

test('запрос: создаётся, виден всем, чужие не могут менять', async () => {
    const { requests, reg, store } = await setup();
    const a = await reg('Анна'), b = await reg('Борис');
    const r = await requests.create(a, REQ());
    assert.equal(r.ok, true);
    assert.equal(r.request.status, 'active');
    assert.equal(requests.list({ viewerId: b.id }).length, 1);
    assert.equal(requests.list({ viewerId: b.id })[0].mine, false);
    assert.equal((await requests.edit(b, r.request.id, REQ({ city: 'Сочи' }))).code, 'NOT_OWNER');
    assert.equal((await requests.setStatus(b, r.request.id, 'closed')).code, 'NOT_OWNER');
    await store.close();
});

test('запрос: не чаще раза в 60 секунд, таймер считает сервер', async () => {
    const { requests, reg, clock, store } = await setup();
    const a = await reg('Анна');
    assert.equal((await requests.create(a, REQ())).ok, true);
    let r = await requests.create(a, REQ({ city: 'Сочи' }));
    assert.equal(r.code, 'REQUEST_WAIT');
    assert.equal(r.wait, 60);
    clock.t += 43000;
    r = await requests.create(a, REQ({ city: 'Сочи' }));
    assert.equal(r.code, 'REQUEST_WAIT'); assert.equal(r.wait, 17);
    clock.t += 17000;
    assert.equal((await requests.create(a, REQ({ city: 'Сочи' }))).ok, true);
    await store.close();
});

test('запрос: параллельные отправки пропускают только одну', async () => {
    const { requests, reg, store } = await setup();
    const a = await reg('Анна');
    const all = await Promise.all([1, 2, 3, 4, 5].map(i => requests.create(a, REQ({ city: 'Город' + i }))));
    assert.equal(all.filter(r => r.ok).length, 1);
    assert.equal(requests.list({ viewerId: a.id }).length, 1);
    await store.close();
});

test('запрос: дубликат, лимит активных, неверные поля', async () => {
    const { requests, reg, clock, store } = await setup();
    const a = await reg('Анна');
    assert.equal((await requests.create(a, REQ())).ok, true);
    clock.t += 61000;
    assert.equal((await requests.create(a, REQ())).code, 'REQUEST_DUPLICATE');
    for (const bad of [REQ({ dateFrom: '2020-01-01' }), REQ({ dateTo: '2027-03-01' }), REQ({ guests: 99 }), REQ({ budget: -5 }), REQ({ dateFrom: 'завтра' }), { }, null]) {
        assert.equal((await requests.create(a, bad)).code, 'BAD_REQUEST', JSON.stringify(bad));
    }
    for (let i = 0; i < 4; i++) { clock.t += 61000; assert.equal((await requests.create(a, REQ({ city: 'Г' + i }))).ok, true); }
    clock.t += 61000;
    assert.equal((await requests.create(a, REQ({ city: 'Лишний' }))).code, 'TOO_MANY_REQUESTS');
    await store.close();
});

test('запрос: правка без лимита и без подъёма в ленте', async () => {
    const { requests, reg, clock, store } = await setup();
    const a = await reg('Анна');
    const first = (await requests.create(a, REQ({ city: 'Первый' }))).request;
    clock.t += 61000;
    const second = (await requests.create(a, REQ({ city: 'Второй' }))).request;
    assert.deepEqual(requests.list({ viewerId: a.id }).map(r => r.id), [second.id, first.id]);
    clock.t += 1000;
    const e = await requests.edit(a, first.id, REQ({ city: 'Первый', budget: 4000 }));   // сразу, без ожидания
    assert.equal(e.ok, true);
    assert.equal(e.request.budget, 4000);
    assert.deepEqual(requests.list({ viewerId: a.id }).map(r => r.id), [second.id, first.id], 'порядок не изменился');
    assert.equal(requests.cooldown(a.id) > 0, true, 'правка не сбросила и не обошла таймер');
    await store.close();
});

test('запрос: статусы и срок актуальности', async () => {
    const { requests, reg, clock, store } = await setup();
    const a = await reg('Анна');
    const r = (await requests.create(a, REQ())).request;
    assert.equal((await requests.setStatus(a, r.id, 'found')).request.status, 'found');
    assert.equal(requests.list({ viewerId: a.id }).length, 0);
    assert.equal(requests.list({ viewerId: a.id, status: 'found' }).length, 1);
    assert.equal((await requests.edit(a, r.id, REQ())).code, 'BAD_REQUEST', 'завершённый не редактируется');
    clock.t += 61000;
    const r2 = (await requests.create(a, REQ({ city: 'Сочи' }))).request;
    clock.t += 15 * DAY;
    assert.equal(requests.get(r2.id, a.id).status, 'expired');
    assert.equal(requests.list({ viewerId: a.id }).length, 0);
    assert.equal(requests.list({ viewerId: a.id, status: 'expired' }).length, 1);
    await store.close();
});

test('запрос: сохраняется на диск и переживает перезапуск вместе с таймером', async () => {
    const { requests, reg, cfg, clock, store } = await setup();
    const a = await reg('Анна');
    await requests.create(a, REQ());
    const again = new RequestStore({ dataDir: cfg.dataDir, limits: cfg.limits, now: () => clock.t, logger: silent }); await again.init();
    assert.equal(again.list({ viewerId: a.id }).length, 1);
    assert.equal(again.cooldown(a.id), 60);
    await store.close();
});

test('запрос: при сбое записи ничего не остаётся и лимит не тратится', async () => {
    const { cfg, clock, reg, store } = await setup();
    const a = await reg('Анна');
    const bad = { mkdir: async () => {}, readFile: async () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; }, open: async () => { throw new Error('disk'); }, writeFile: async () => {}, rename: async () => {} };
    const rs = new RequestStore({ dataDir: cfg.dataDir + '/x', limits: cfg.limits, now: () => clock.t, logger: silent, fsImpl: bad }); await rs.init();
    assert.equal((await rs.create(a, REQ())).code, 'STORE_UNAVAILABLE');
    assert.equal(rs.list({ viewerId: a.id }).length, 0);
    assert.equal(rs.cooldown(a.id), 0);
    await store.close();
});

test('HTTP запросы: вход обязателен, список открыт, таймер в ответе', async () => {
    const { h, reg, store } = await setup();
    const a = await reg('Анна');
    const hdr = { authorization: 'Bearer ' + a.token };
    let r = res(); await h.requestCreate(req({ body: REQ() }), r); assert.equal(r.code, 401);
    r = res(); await h.requestCreate(req({ headers: hdr, body: REQ() }), r); assert.equal(r.code, 200);
    const id = r.body.request.id;
    assert.ok(r.body.cooldown > 0);
    r = res(); await h.requestCreate(req({ headers: hdr, body: REQ({ city: 'Сочи' }) }), r); assert.equal(r.code, 429); assert.ok(r.body.wait > 0);
    r = res(); h.requestsList(req(), r); assert.equal(r.body.requests.length, 1); assert.equal(r.body.cooldown, 0);
    r = res(); h.requestsList(req({ query: { mine: '1' } }), r); assert.equal(r.code, 401);
    r = res(); h.requestsList(req({ headers: hdr, query: { mine: '1' } }), r); assert.equal(r.body.requests.length, 1); assert.ok(r.body.cooldown > 0);
    r = res(); await h.requestStatus(req({ headers: hdr, params: { id }, body: { status: 'closed' } }), r); assert.equal(r.body.request.status, 'closed');
    r = res(); await h.requestStatus(req({ headers: hdr, params: { id }, body: { status: 'active' } }), r); assert.equal(r.code, 400);
    await store.close();
});

test('объявления: 3 новых в день, правка не тратит, удаление не возвращает', async () => {
    const { h, reg, listings, clock, store } = await setup();
    const u = await reg('Хозяйка', true);
    const hdr = { authorization: 'Bearer ' + u.token };
    const save = async (n, id) => { const r = res(); await h.listingSave(req({ headers: hdr, body: { id, ad: AD(n), profile: {} } }), r); return r; };
    const ids = [];
    for (let i = 1; i <= 3; i++) { const r = await save(i); assert.equal(r.code, 200); assert.equal(r.body.quota.used, i); ids.push(r.body.listing.id); }
    let r = await save(4); assert.equal(r.code, 429); assert.equal(r.body.code, 'DAILY_LIMIT'); assert.equal(r.body.quota.left, 0);
    r = await save('3 правка', ids[2]); assert.equal(r.code, 200, 'правка бесплатна');
    r = res(); await h.listingDelete(req({ headers: hdr, params: { id: ids[0] } }), r); assert.equal(r.code, 200);
    r = await save(5); assert.equal(r.code, 429, 'удаление не возвращает публикацию');
    r = res(); h.listingQuota(req({ headers: hdr }), r); assert.equal(r.body.quota.used, 3);
    clock.t += DAY;                                           // следующие сутки
    r = await save(6); assert.equal(r.code, 200);
    assert.equal(listings.quota(u.id).used, 1);
    await store.close();
});

test('объявления: параллельные публикации не создают четвёртое', async () => {
    const { listings, reg, store } = await setup();
    const u = await reg('Хозяйка', true);
    const all = await Promise.all([1, 2, 3, 4, 5, 6].map(i => listings.save(u, { ad: AD(i), profile: {} })));
    assert.equal(all.filter(r => r.ok).length, 3);
    assert.equal(all.filter(r => r.code === 'DAILY_LIMIT').length, 3);
    assert.equal(listings.list().length, 3);
    await store.close();
});

test('объявления: счётчик по полуночи сервиса (Москва), а не UTC', async () => {
    const { reg, cfg, clock, accounts, store } = await setup();
    const u = await reg('Хозяйка', true);
    const { dayKey } = require('../src/listings');
    assert.equal(dayKey(Date.parse('2027-03-10T20:59:00Z'), 'Europe/Moscow'), '2027-03-10');
    assert.equal(dayKey(Date.parse('2027-03-10T21:01:00Z'), 'Europe/Moscow'), '2027-03-11');
    await store.close();
});
