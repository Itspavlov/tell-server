'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountStore, nameKey } = require('../src/accounts');
const { ListingStore } = require('../src/listings');
const { FavoriteStore } = require('../src/favorites');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { makeCfg, makeStore, makeIo, limiters, silent, PNG } = require('./helpers');

const PW = 'correct horse 9';
async function setup() {
    const cfg = makeCfg();
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const listings = new ListingStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger: silent }); await listings.init();
    const favorites = new FavoriteStore({ dataDir: cfg.dataDir, logger: silent }); await favorites.init();
    const store = await makeStore(cfg);
    const h = createHandlers({ cfg, store, admin: createAdmin({ token: '', dataDir: cfg.dataDir, logger: silent }), accounts, listings, favorites, limiters: limiters(cfg), io: makeIo(), logger: silent });
    const owner = await accounts.register('Хозяйка', PW); await accounts.setVerified(nameKey('Хозяйка'), true);
    const a = await accounts.register('Анна', PW), b = await accounts.register('Борис', PW);
    const add = async (n) => (await listings.save(accounts.authenticate(owner.token), { ad: { type: 'rent', title: 'Студия ' + n, priceNum: 3000, price: '3000', location: 'Адлер', photos: [PNG], thumb: PNG }, profile: {} })).listing.id;
    return { cfg, cleanup: () => store.close(), accounts, listings, favorites, h, owner, a, b, add };
}
const res = () => { const r = { code: 200, body: null }; r.status = c => { r.code = c; return r; }; r.json = x => { r.body = x; return r; }; r.set = () => r; return r; };
const rq = (tok, body) => ({ ip: '6.6.6.6', params: {}, query: {}, headers: tok ? { authorization: 'Bearer ' + tok } : {}, body: body || {} });

test('избранное: добавить, убрать, у каждого своё', async () => {
    const s = await setup();
    const l1 = await s.add(1), l2 = await s.add(2);
    assert.deepEqual((await s.favorites.set(s.a.user.id, l1, true, s.listings)).ids, [l1]);
    assert.deepEqual((await s.favorites.set(s.a.user.id, l2, true, s.listings)).ids, [l2, l1], 'новые сверху');
    assert.deepEqual((await s.favorites.set(s.a.user.id, l2, true, s.listings)).ids, [l2, l1], 'повтор не дублирует');
    assert.deepEqual(s.favorites.ids(s.b.user.id), []);
    assert.deepEqual((await s.favorites.set(s.a.user.id, l1, false, s.listings)).ids, [l2]);
    assert.equal((await s.favorites.set(s.a.user.id, 'l_нет', true, s.listings)).code, 'LISTING_NOT_FOUND');
    await s.cleanup();
});

test('избранное: удалённое объявление пропадает из списка; сохраняется после перезапуска', async () => {
    const s = await setup();
    const l1 = await s.add(1), l2 = await s.add(2);
    await s.favorites.set(s.a.user.id, l1, true, s.listings); await s.favorites.set(s.a.user.id, l2, true, s.listings);
    await s.listings.remove(s.accounts.authenticate(s.owner.token), l1);
    assert.deepEqual(s.favorites.list(s.a.user.id, s.listings).map(x => x.id), [l2]);
    const again = new FavoriteStore({ dataDir: s.cfg.dataDir, logger: silent }); await again.init();
    assert.deepEqual(again.ids(s.a.user.id), [l2, l1]);
    await s.cleanup();
});

test('HTTP избранное: нужен вход, добавление и список', async () => {
    const s = await setup();
    const l1 = await s.add(1);
    let r = res(); s.h.favList(rq(null), r); assert.equal(r.code, 401);
    r = res(); await s.h.favSet(rq(null, { id: l1, on: true }), r); assert.equal(r.code, 401);
    r = res(); await s.h.favSet(rq(s.a.token, { id: l1, on: true }), r); assert.deepEqual(r.body.ids, [l1]);
    r = res(); s.h.favList(rq(s.a.token), r); assert.equal(r.body.listings.length, 1); assert.equal(r.body.listings[0].title, 'Студия 1');
    r = res(); s.h.favList(rq(s.b.token), r); assert.equal(r.body.listings.length, 0);
    r = res(); await s.h.favSet(rq(s.a.token, { id: 'l_нет', on: true }), r); assert.equal(r.code, 404);
    await s.cleanup();
});
