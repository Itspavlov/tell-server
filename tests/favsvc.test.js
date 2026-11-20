'use strict';
// Избранное для готовых услуг и рейтинг автора на карточке услуги
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountStore } = require('../src/accounts');
const { ListingStore } = require('../src/listings');
const { ServiceStore } = require('../src/services');
const { FavoriteStore } = require('../src/favorites');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { makeCfg, makeStore, makeIo, limiters, silent, PNG } = require('./helpers');

const PW = 'correct horse 9';
async function setup(reviews = null) {
    const cfg = makeCfg();
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const listings = new ListingStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger: silent }); await listings.init();
    const services = new ServiceStore({ dataDir: cfg.dataDir, accounts, logger: silent }); await services.init();
    const favorites = new FavoriteStore({ dataDir: cfg.dataDir, logger: silent }); await favorites.init();
    const store = await makeStore(cfg);
    const h = createHandlers({ cfg, store, admin: createAdmin({ token: '', dataDir: cfg.dataDir, logger: silent }), accounts, listings, services, favorites, reviews, limiters: limiters(cfg), io: makeIo(), logger: silent });
    const reg = async (n) => { const u = await accounts.register(n, PW); return { ...accounts.authenticate(u.token), token: u.token }; };
    return { cfg, store, accounts, listings, services, favorites, h, reg };
}
const res = () => { const r = { code: 200, body: null }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.set = () => r; return r; };
const rq = (tok, o = {}) => ({ ip: '6.6.6.6', params: {}, query: {}, headers: tok ? { authorization: 'Bearer ' + tok } : {}, body: {}, ...o });
const SV = { title: 'Морские прогулки', tag: 'sea', text: 'Катер, 2 часа', city: 'Архипо-Осиповка', price: 3000, unit: 'за билет', photos: [PNG] };

test('услуга в избранном: добавить, убрать, список; удалённой нет', async () => {
    const s = await setup();
    const own = await s.reg('Капитан'), a = await s.reg('Анна');
    const id = (await s.services.save(own, SV)).service.id;
    let r = res(); await s.h.favSet(rq(a.token, { body: { id, on: true } }), r);
    assert.equal(r.code, 200); assert.deepEqual(r.body.ids, [id]);
    r = res(); s.h.favList(rq(a.token), r);
    assert.deepEqual(r.body.listings, []); assert.equal(r.body.services.length, 1); assert.equal(r.body.services[0].title, 'Морские прогулки');
    assert.ok(!r.body.services[0].photos, 'в списке только обложка, без всех фото');
    r = res(); await s.h.favSet(rq(a.token, { body: { id: 's_нет', on: true } }), r); assert.equal(r.code, 404);
    r = res(); await s.h.favSet(rq(a.token, { body: { id, on: false } }), r); assert.deepEqual(r.body.ids, []);
    await s.favorites.set(a.id, id, true, s.listings, s.services);
    await s.services.remove(own, id);
    assert.deepEqual(s.favorites.listServices(a.id, s.services), [], 'удалённая услуга пропадает из избранного');
    await s.store.close();
});

test('рейтинг профиля на карточках услуг: один на все объявления автора', async () => {
    const reviews = { ownerStats: (id) => id === 'x' ? null : { rating: 4.8, count: 3 } };
    const s = await setup(reviews);
    const own = await s.reg('Капитан');
    const id = (await s.services.save(own, SV)).service.id;
    let r = res(); s.h.servicesList(rq(null), r);
    assert.equal(r.body.services[0].rating, 4.8); assert.equal(r.body.services[0].reviews, 3);
    r = res(); s.h.serviceGet(rq(null, { params: { id } }), r);
    assert.equal(r.body.service.rating, 4.8);
    // без отзывов рейтинга нет
    const s2 = await setup({ ownerStats: () => ({ rating: null, count: 0 }) });
    const o2 = await s2.reg('Новичок'); await s2.services.save(o2, SV);
    r = res(); s2.h.servicesList(rq(null), r);
    assert.equal(r.body.services[0].rating, undefined);
    await s.store.close(); await s2.store.close();
});
