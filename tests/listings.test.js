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
async function setup(over = {}) {
    const cfg = makeCfg();
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const limits = { ...cfg.limits, ...over };
    const listings = new ListingStore({ dataDir: cfg.dataDir, accounts, limits, logger: silent }); await listings.init();
    const store = await makeStore(cfg);
    const io = makeIo();
    const admin = createAdmin({ token: '', dataDir: cfg.dataDir, logger: silent });
    const h = createHandlers({ cfg, store, admin, accounts, listings, limiters: limiters(cfg), io, logger: silent });
    const regRaw = async (n) => (await accounts.register(n, PW));
    // по умолчанию в тестах владелец уже проверен администратором
    const reg = async (n) => { const u = await regRaw(n); await accounts.setVerified(nameKey(n), true); return u; };
    return { cfg, accounts, listings, store, io, h, reg, regRaw };
}
const res = () => { const r = { code: 200, body: null }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.set = () => r; return r; };
const req = (o = {}) => ({ ip: '4.4.4.4', params: {}, query: {}, headers: {}, body: {}, ...o });
const auth = (t) => ({ authorization: 'Bearer ' + t });
const AD = (extra = {}) => ({
    type: 'rent', title: 'Студия у моря', priceNum: 3000, price: '3 000 ₽/сут', location: 'Анапа, Набережная 1',
    description: 'Уютно', photos: [PNG, PNG], thumb: PNG, facts: [{ i: 'fa-users', t: 'до 3 гостей' }],
    amenities: ['wifi', 'ac'], terms: [{ i: 'fa-key', l: 'Заезд', v: 'с 14:00' }], rules: ['Без курения'],
    coords: [44.89, 37.31], beach: [44.88, 37.30], busy: ['2027-01-10'], since: 2024,
    form: { rooms: '1', guests: '3' }, ...extra
});
const PROFILE = { phone: '+7 900 000-00-00', about: 'Хозяйка', avatar: '' };

test('объявление: сохраняется, видно всем, список лёгкий, полное по id', async () => {
    const { h, reg, store } = await setup();
    const u = await reg('Хозяйка');
    let r = res(); await h.listingSave(req({ headers: auth(u.token), body: { ad: AD(), profile: PROFILE } }), r);
    assert.equal(r.code, 200);
    const id = r.body.listing.id;
    r = res(); h.listingsList(req(), r);          // без входа
    assert.equal(r.body.listings.length, 1);
    const light = r.body.listings[0];
    assert.equal(light.partial, true);
    assert.equal(light.photos.length, 1);
    assert.equal(light.owner.name, 'Хозяйка');
    assert.equal(light.owner.phone, '+7 900 000-00-00');
    r = res(); h.listingGet(req({ params: { id } }), r);
    assert.equal(r.body.listing.partial, false);
    assert.equal(r.body.listing.photos.length, 2);
    assert.equal(r.body.listing.form.rooms, '1');
    await store.close();
});

test('объявление: без входа нельзя; оповещение всех при изменении', async () => {
    const { h, reg, io, store } = await setup();
    let r = res(); await h.listingSave(req({ body: { ad: AD() } }), r);
    assert.equal(r.code, 401);
    const u = await reg('Хозяйка');
    r = res(); await h.listingSave(req({ headers: auth(u.token), body: { ad: AD() } }), r);
    assert.ok(io.emitted.some(e => e.ev === 'listing-changed' && e.payload.id === r.body.listing.id));
    await store.close();
});

test('объявление: имя владельца берётся из аккаунта, а не от клиента', async () => {
    const { h, reg, store } = await setup();
    const u = await reg('Настоящее');
    const r = res(); await h.listingSave(req({ headers: auth(u.token), body: { ad: { ...AD(), owner: { name: 'Подделка' }, ownerId: 'u_x' }, profile: { ...PROFILE, name: 'Подделка' } } }), r);
    assert.equal(r.body.listing.owner.name, 'Настоящее');
    assert.equal(r.body.listing.ownerId, u.user.id);
    await store.close();
});

test('объявление: чужое менять и удалять нельзя, своё можно', async () => {
    const { h, reg, store } = await setup();
    const a = await reg('Хозяйка'), b = await reg('Чужой');
    let r = res(); await h.listingSave(req({ headers: auth(a.token), body: { ad: AD() } }), r);
    const id = r.body.listing.id;
    r = res(); await h.listingSave(req({ headers: auth(b.token), body: { id, ad: AD({ title: 'Взлом объявления' }) } }), r);
    assert.equal(r.code, 403);
    r = res(); await h.listingDelete(req({ headers: auth(b.token), params: { id } }), r);
    assert.equal(r.code, 403);
    r = res(); await h.listingSave(req({ headers: auth(a.token), body: { id, ad: AD({ title: 'Новое название' }) } }), r);
    assert.equal(r.body.listing.title, 'Новое название');
    r = res(); await h.listingDelete(req({ headers: auth(a.token), params: { id } }), r);
    assert.equal(r.code, 200);
    r = res(); h.listingsList(req(), r);
    assert.equal(r.body.listings.length, 0);
    await store.close();
});

test('объявление: опасные данные отклоняются или чистятся', async () => {
    const { h, reg, store } = await setup();
    const u = await reg('Хозяйка');
    const send = async (ad, profile = PROFILE) => { const r = res(); await h.listingSave(req({ headers: auth(u.token), body: { ad, profile } }), r); return r; };
    assert.equal((await send(AD({ photos: ['javascript:alert(1)'] }))).code, 400);
    assert.equal((await send(AD({ photos: ['data:image/svg+xml;base64,' + Buffer.from('<svg onload=1>').toString('base64')] }))).code, 400);
    assert.equal((await send(AD({ title: 'ab' }))).code, 400);
    assert.equal((await send(AD({ priceNum: -5 }))).code, 400);
    assert.equal((await send(AD({ photos: Array(7).fill(PNG) }))).code, 200);   // лишние фото обрезаются до 6
    const r = await send(AD({
        title: 'Дом <script>alert(1)</script>', facts: [{ i: 'fa-x" onmouseover="1', t: 'bad' }, { i: 'fa-users', t: 'ок' }],
        amenities: ['wifi', '"><img src=x>'], busy: ['2027-01-01', 'не дата'], coords: [999, 5], thumb: ''
    }), { phone: 'javascript:1', about: 'о себе', avatar: 'http://evil/x.png' });
    assert.equal(r.code, 200);
    const l = r.body.listing;
    assert.equal(l.facts.length, 1);
    assert.deepEqual(l.amenities, ['wifi']);
    assert.deepEqual(l.busy, ['2027-01-01']);
    assert.equal(l.coords, null);
    assert.equal(l.owner.phone, '');
    assert.equal(l.owner.avatar, '');
    assert.equal(r.body.listing.photos.length, 2);
    await store.close();
});

test('объявление: максимум 20 на человека и лимит размера хранилища', async () => {
    const { h, reg, store } = await setup();
    const u = await reg('Хозяйка');
    for (let i = 0; i < 20; i++) { const r = res(); await h.listingSave(req({ headers: auth(u.token), ip: '9.9.9.' + i, body: { ad: AD({ title: 'Объявление ' + i }) } }), r); assert.equal(r.code, 200, 'i=' + i); }
    const r = res(); await h.listingSave(req({ headers: auth(u.token), ip: '9.9.9.99', body: { ad: AD() } }), r);
    assert.equal(r.body.code === 'TOO_MANY_LISTINGS' || r.code === 429, true);
    await store.close();
    const small = await setup({ maxListingsBytes: 500 });
    const u2 = await small.reg('Маленький');
    const r2 = res(); await small.h.listingSave(req({ headers: auth(u2.token), body: { ad: AD() } }), r2);
    assert.equal(r2.body.code, 'LISTINGS_FULL');
    await small.store.close();
});

test('объявления переживают перезапуск; повреждённый файл не затирается', async () => {
    const { h, reg, cfg, accounts, store } = await setup();
    const u = await reg('Хозяйка');
    const r = res(); await h.listingSave(req({ headers: auth(u.token), body: { ad: AD() } }), r);
    const again = new ListingStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger: silent }); await again.init();
    assert.equal(again.get(r.body.listing.id).title, 'Студия у моря');
    await store.close();
    const cfg2 = makeCfg();
    const f = path.join(cfg2.dataDir, 'listings.json');
    fs.writeFileSync(f, '{"listings": ');
    const acc2 = new AccountStore({ dataDir: cfg2.dataDir, limits: cfg2.limits, logger: silent }); await acc2.init();
    const bad = new ListingStore({ dataDir: cfg2.dataDir, accounts: acc2, limits: cfg2.limits, logger: silent });
    await assert.rejects(() => bad.init(), (e) => e.code === 'CORRUPT');
    assert.equal(fs.readFileSync(f, 'utf-8'), '{"listings": ');
});

test('объявление: непроверенный не может разместить; после проверки может, значок виден', async () => {
    const { h, regRaw, accounts, store } = await setup();
    const u = await regRaw('Новичок');
    let r = res(); await h.listingSave(req({ headers: auth(u.token), body: { ad: AD(), profile: PROFILE } }), r);
    assert.equal(r.code, 403);
    assert.equal(r.body.code, 'NOT_VERIFIED');
    assert.equal(await accounts.setVerified(nameKey('Новичок'), true), true);
    r = res(); await h.listingSave(req({ headers: auth(u.token), body: { ad: AD(), profile: PROFILE } }), r);
    assert.equal(r.code, 200);
    assert.equal(r.body.listing.isVerified, true);
    await store.close();
});

test('заявка на проверку: сохраняется, видна админу, пропадает после проверки', async () => {
    const { regRaw, accounts, store } = await setup();
    const u = await regRaw('Хозяин');
    assert.equal(nameKey('Хозяин') !== undefined, true);
    const a = accounts.authenticate(u.token);
    const r = await accounts.requestVerification(a.id, 'Сдаю квартиру в Анапе, тел. +7…');
    assert.equal(r.ok, true);
    assert.equal(accounts.listVerifyRequests().length, 1);
    assert.equal(accounts.listVerifyRequests()[0].name, 'Хозяин');
    await accounts.setVerified(nameKey('Хозяин'), true);
    assert.equal(accounts.listVerifyRequests().length, 0);
    assert.equal((await accounts.requestVerification(a.id, 'x')).already, true);
    await store.close();
});

test('админ: выдача статуса «проверен» только по токену, заявки видны, всё пишется в аудит', async () => {
    const cfg = makeCfg();
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const listings = new ListingStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger: silent }); await listings.init();
    const store = await makeStore(cfg);
    const TOKEN = 'a'.repeat(40);
    const admin = createAdmin({ token: TOKEN, dataDir: cfg.dataDir, logger: silent });
    const h = createHandlers({ cfg, store, admin, accounts, listings, limiters: limiters(cfg), io: makeIo(), logger: silent });
    const u = await accounts.register('Хозяин', PW);
    // заявка
    let r = res(); await h.verifyRequest(req({ headers: auth(u.token), body: { note: 'Сдаю жильё' } }), r);
    assert.equal(r.code, 200);
    r = res(); await h.verifyRequest(req({ body: {} }), r);
    assert.equal(r.code, 401);
    // без токена админа нельзя
    r = res(); await h.adminVerifyRequests(req({ headers: { authorization: 'Bearer wrong' } }), r);
    assert.equal(r.code, 401);
    r = res(); await h.adminVerify(req({ headers: { authorization: 'Bearer wrong' }, body: { name: 'Хозяин', verified: true } }), r);
    assert.equal(r.code, 401);
    assert.equal(accounts.findByKey(nameKey('Хозяин')).verified, false);
    // по токену
    r = res(); await h.adminVerifyRequests(req({ headers: { authorization: 'Bearer ' + TOKEN } }), r);
    assert.equal(r.body.requests.length, 1);
    r = res(); await h.adminVerify(req({ headers: { authorization: 'Bearer ' + TOKEN }, body: { name: 'хозяин', verified: true } }), r);
    assert.equal(r.code, 200);
    assert.equal(accounts.findByKey(nameKey('Хозяин')).verified, true);
    r = res(); await h.adminVerify(req({ headers: { authorization: 'Bearer ' + TOKEN }, body: { name: 'Нет', verified: true } }), r);
    assert.equal(r.code, 404);
    r = res(); await h.adminVerify(req({ headers: { authorization: 'Bearer ' + TOKEN }, body: { name: 'Хозяин' } }), r);
    assert.equal(r.code, 400);
    r = res(); h.me(req({ headers: auth(u.token) }), r);
    assert.equal(r.body.user.verified, true);
    const log = fs.readFileSync(path.join(cfg.dataDir, 'audit.log'), 'utf-8');
    assert.ok(log.includes('"action":"verify"'));
    assert.equal(log.includes(TOKEN), false);
    await store.close();
});
