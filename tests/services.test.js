'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountStore, nameKey } = require('../src/accounts');
const { ListingStore } = require('../src/listings');
const { ServiceStore } = require('../src/services');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { makeCfg, makeStore, makeIo, limiters, silent, PNG } = require('./helpers');

const PW = 'correct horse 9';
async function setup() {
    const cfg = makeCfg();
    const clock = { t: Date.parse('2027-03-10T12:00:00Z') };
    const now = () => clock.t;
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const listings = new ListingStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, now, logger: silent }); await listings.init();
    const services = new ServiceStore({ dataDir: cfg.dataDir, accounts, now, logger: silent }); await services.init();
    const store = await makeStore(cfg);
    const admin = createAdmin({ token: '', dataDir: cfg.dataDir, logger: silent });
    const h = createHandlers({ cfg, store, admin, accounts, listings, services, limiters: limiters(cfg), io: makeIo(), logger: silent });
    const reg = async (n, verified) => { const u = await accounts.register(n, PW); if (verified) await accounts.setVerified(nameKey(n), true); return { ...accounts.authenticate(u.token), token: u.token }; };
    return { cfg, clock, accounts, listings, services, store, h, reg };
}
const res = () => { const r = { code: 200, body: null }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.set = () => r; return r; };
const req = (o = {}) => ({ ip: '4.4.4.4', params: {}, query: {}, headers: {}, body: {}, ...o });
const SV = (o = {}) => ({ title: 'Прогулки на джипах', tag: 'tours', text: 'Горы и водопады, 4 часа', city: 'Сочи', price: 2500, unit: 'за человека', photos: [PNG, PNG], ...o });

test('услуга: проверка полей, фото и лимиты', async () => {
    const { services, reg, store } = await setup();
    const a = await reg('Анна');
    assert.equal((await services.save(a, SV({ title: '  ' }))).code, 'SERVICE_TITLE');
    assert.equal((await services.save(a, SV({ photos: ['data:image/png;base64,AAAA'] }))).code, 'IMAGE_INVALID');
    assert.equal((await services.save(a, SV({ photos: [PNG, PNG, PNG, PNG, PNG] }))).code, 'IMAGE_INVALID');
    assert.equal((await services.save(a, SV({ price: -5 }))).ok, false);
    const r = await services.save(a, SV({ tag: 'нечто', unit: 'за что-то' }));
    assert.equal(r.ok, true);
    assert.equal(r.service.tag, 'other'); assert.equal(r.service.unit, '');          // чужое значение заменяется безопасным
    assert.equal(r.service.photos.length, 2); assert.ok(r.service.thumb);
    for (let i = 0; i < 9; i++) assert.equal((await services.save(a, SV({ title: 'Услуга ' + i }))).ok, true);
    assert.equal((await services.save(a, SV())).code, 'TOO_MANY_SERVICES');          // всего 10
    await store.close();
});

test('услуга: видят все, менять может только автор, список лёгкий', async () => {
    const { services, reg, store } = await setup();
    const a = await reg('Анна'), b = await reg('Борис');
    const r = await services.save(a, SV());
    const light = services.list({ ownerId: a.id })[0];
    assert.equal(light.photos, undefined); assert.equal(light.photoCount, 2); assert.equal(light.ownerName, 'Анна');
    assert.equal(services.get(r.service.id).photos.length, 2);
    assert.equal((await services.save(b, { ...SV(), id: r.service.id })).code, 'NOT_OWNER');
    assert.equal((await services.remove(b, r.service.id)).code, 'NOT_OWNER');
    const e = await services.save(a, { ...SV({ title: 'Джипы и квадроциклы' }), id: r.service.id });
    assert.equal(e.ok, true); assert.equal(e.created, false); assert.equal(services.list().length, 1);
    assert.equal((await services.remove(a, r.service.id)).ok, true);
    assert.equal(services.list().length, 0);
    await store.close();
});

test('поднятие услуги и объявления: раз в 6 часов, только хозяин', async () => {
    const { services, listings, clock, reg, store } = await setup();
    const a = await reg('Анна', true), b = await reg('Борис');
    const s = (await services.save(a, SV())).service;
    clock.t += 3600_000;
    const s2 = (await services.save(a, SV({ title: 'Вторая' }))).service;
    assert.equal(services.list()[0].id, s2.id);
    assert.equal((await services.bump(b, s.id)).code, 'NOT_OWNER');
    assert.equal((await services.bump(a, s.id)).ok, true);
    assert.equal(services.list()[0].id, s.id);                                          // поднялась наверх
    const w = await services.bump(a, s.id);
    assert.equal(w.code, 'BUMP_WAIT'); assert.ok(w.wait > 0);
    clock.t += 7 * 3600_000;
    assert.equal((await services.bump(a, s.id)).ok, true);
    // объявление жилья
    const l = await listings.save(a, { ad: { type: 'rent', title: 'Студия', priceNum: 3000, price: '3 000', location: 'Анапа', description: 'x', photos: [PNG], thumb: PNG }, profile: {} });
    assert.equal(l.ok, true);
    clock.t += 3600_000;
    const l2 = (await listings.save(a, { ad: { type: 'rent', title: 'Другая', priceNum: 3000, price: '3 000', location: 'Анапа', description: 'x', photos: [PNG], thumb: PNG }, profile: {} })).listing;
    assert.equal(listings.list()[0].id, l2.id);
    assert.equal((await listings.bump(b, l.listing.id)).code, 'NOT_OWNER');
    const q0 = listings.quota(a.id).used;
    assert.equal((await listings.bump(a, l.listing.id)).ok, true);
    assert.equal(listings.list()[0].id, l.listing.id);
    assert.equal(listings.quota(a.id).used, q0, 'поднятие не тратит дневной лимит');
    assert.equal((await listings.bump(a, l.listing.id)).code, 'BUMP_WAIT');
    await store.close();
});

test('профиль человека отдаёт его услуги, смена имени обновляет карточки, админ удаляет любую', async () => {
    const { services, h, accounts, reg, store } = await setup();
    const a = await reg('Анна');
    const s = (await services.save(a, SV())).service;
    const r = res(); h.userProfile(req({ query: { id: a.id } }), r);
    assert.equal(r.body.services.length, 1); assert.equal(r.body.services[0].id, s.id);
    assert.equal(await services.renameOwner(a.id, 'Алиса'), 1);
    assert.equal(services.data.items[s.id].ownerName, 'Алиса');
    const mine = res(); h.servicesList(req({ query: { mine: '1' }, headers: { authorization: 'Bearer ' + a.token } }), mine);
    assert.equal(mine.body.services.length, 1);
    const anon = res(); h.servicesList(req({ query: { mine: '1' } }), anon);
    assert.equal(anon.code, 401);
    assert.equal((await services.remove(null, s.id, { admin: true })).ok, true);
    await store.close();
});

test('развлечения: категории «морские прогулки», «экскурсии»; прежние «услуги» заменяются на «другое»', async () => {
    const { services, reg, store } = await setup();
    const a = await reg('Борис');
    for (const t of ['sea', 'tours', 'active', 'kids', 'show', 'food']) assert.equal((await services.save(a, SV({ tag: t, title: 'К ' + t }))).service.tag, t);
    assert.equal((await services.save(a, SV({ tag: 'repair' }))).service.tag, 'other');
    assert.equal((await services.save(a, SV({ unit: 'за билет' }))).service.unit, 'за билет');
    await store.close();
});

test('услуга: точка на карте и «куда подойти» сохраняются, мусор отклоняется', async () => {
    const { services, reg, store } = await setup();
    const a = await reg('Вера');
    const r = await services.save(a, SV({ coords: [44.894612, 37.310099], place: 'Причал №3' }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.service.coords, [44.89461, 37.3101]); assert.equal(r.service.place, 'Причал №3');
    assert.deepEqual(services.list()[0].coords, [44.89461, 37.3101]);                      // точка есть и в списке: кнопка «Карта» без лишнего запроса
    const none = await services.save(a, SV({ title: 'Без точки' }));
    assert.equal(none.service.coords, null); assert.equal(none.service.place, '');
    for (const bad of [[1], ['a', 'b'], [95, 10], [10, 200], 'x', {}]) assert.equal((await services.save(a, SV({ coords: bad }))).ok, false);
    await store.close();
});
