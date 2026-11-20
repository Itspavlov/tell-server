'use strict';
// «Прогулка» по объявлению: лента кадров из видео хозяина
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountStore, nameKey } = require('../src/accounts');
const { ListingStore, cleanWalk } = require('../src/listings');
const { MediaStore } = require('../src/media');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { makeCfg, makeStore, makeIo, limiters, silent, PNG } = require('./helpers');

const PW = 'correct horse 9';
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 5)]);
const res = () => { const r = { code: 200, body: null }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.set = () => r; return r; };
const req = (o = {}) => ({ ip: '4.4.4.' + (Math.random() * 200 | 0), params: {}, query: {}, headers: {}, body: {}, ...o });
const auth = (t) => ({ authorization: 'Bearer ' + t });
const AD = (extra = {}) => ({ type: 'rent', title: 'Домик у моря', priceNum: 3000, price: '3 000 ₽/сут', location: 'Архипо-Осиповка', description: 'Уютно', photos: [PNG], thumb: PNG, since: 2024, ...extra });
const WALK = (id, o = {}) => ({ id, n: 30, cols: 6, w: 640, h: 360, ...o });

async function setup() {
    const cfg = makeCfg(); let t = Date.parse('2027-03-10T12:00:00Z'); const now = () => t;
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const listings = new ListingStore({ dataDir: cfg.dataDir, accounts, limits: { ...cfg.limits, dailyListings: 50 }, logger: silent }); await listings.init();
    const media = new MediaStore({ dataDir: cfg.dataDir, logger: silent, now: () => t }); await media.init();
    media.pinned = (id) => listings.usesWalk(id);
    const store = await makeStore(cfg);
    const admin = createAdmin({ token: '', dataDir: cfg.dataDir, logger: silent });
    const h = createHandlers({ cfg, store, admin, accounts, listings, media, limiters: limiters(cfg), io: makeIo(), logger: silent });
    const reg = async (n) => { const u = await accounts.register(n, PW); await accounts.setVerified(nameKey(n), true); return { id: u.user.id, token: u.token }; };
    return { h, reg, media, listings, advance: (ms) => { t += ms; } };
}

test('cleanWalk: только корректная разбивка и id файла', () => {
    const id = 'vm_' + 'a'.repeat(32);
    assert.deepEqual(cleanWalk(WALK(id)), WALK(id));
    assert.equal(cleanWalk(WALK('http://x/y.jpg')), null);
    assert.equal(cleanWalk(WALK(id, { n: 3 })), null);
    assert.equal(cleanWalk(WALK(id, { cols: 0 })), null);
    assert.equal(cleanWalk(WALK(id, { w: 5000 })), null);
    assert.equal(cleanWalk(null), null);
    assert.equal(cleanWalk([id]), null);
});

test('лента кадров: загрузка только JPEG, лимит размера', async () => {
    const { media, reg } = await setup();
    const u = await reg('Хозяин');
    const ok = await media.save(u.id, JPG, 0, 'walk');
    assert.equal(ok.ok, true);
    assert.equal((await media.save(u.id, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3000)]), 0, 'walk')).code, 'BAD_FORMAT');                 // не JPEG
    assert.equal((await media.save(u.id, Buffer.alloc(2_500_000, 1), 0, 'walk')).ok, false);   // слишком большая
    assert.equal(media.info(ok.id).kind, 'walk');
});

test('объявление с прогулкой: свой файл принимается, чужой — нет, пропавший — молча без прогулки', async () => {
    const { h, reg, media } = await setup();
    const u = await reg('Хозяин'), v = await reg('Сосед');
    const mine = (await media.save(u.id, JPG, 0, 'walk')).id;
    const alien = (await media.save(v.id, JPG, 0, 'walk')).id;
    const asPhoto = (await media.save(u.id, JPG, 0, 'photo')).id;

    let r = res(); await h.listingSave(req({ headers: auth(u.token), body: { ad: AD({ walk: WALK(mine) }), profile: {} } }), r);
    assert.equal(r.code, 200); assert.deepEqual(r.body.listing.walk, WALK(mine));
    const id = r.body.listing.id;

    r = res(); await h.listingSave(req({ headers: auth(u.token), body: { ad: AD({ walk: WALK(alien) }), profile: {} } }), r);
    assert.equal(r.code, 400); assert.equal(r.body.code, 'IMAGE_INVALID');
    r = res(); await h.listingSave(req({ headers: auth(u.token), body: { ad: AD({ walk: WALK(asPhoto) }), profile: {} } }), r);
    assert.equal(r.code, 400);                                                                   // обычное фото не годится как лента
    r = res(); await h.listingSave(req({ headers: auth(u.token), body: { ad: AD({ walk: WALK('vm_' + '0'.repeat(32)) }), profile: {} } }), r);
    assert.equal(r.code, 200); assert.equal(r.body.listing.walk, null);

    // в общей ленте (лёгкая версия) разбивка тоже есть, чтобы показать значок
    r = res(); await h.listingsList(req({}), r);
    assert.deepEqual(r.body.listings.find(x => x.id === id).walk, WALK(mine));
    // правка без поля walk убирает прогулку
    r = res(); await h.listingSave(req({ headers: auth(u.token), body: { id, ad: AD(), profile: {} } }), r);
    assert.equal(r.code, 200); assert.equal(r.body.listing.walk, null);
});

test('очистка: файл прогулки живёт, пока есть объявление; сирота исчезает через 30 дней', async () => {
    const { h, reg, media, advance } = await setup();
    const u = await reg('Хозяин');
    const used = (await media.save(u.id, JPG, 0, 'walk')).id;
    const orphan = (await media.save(u.id, JPG, 0, 'walk')).id;
    const photo = (await media.save(u.id, JPG, 0, 'photo')).id;
    const r = res(); await h.listingSave(req({ headers: auth(u.token), body: { ad: AD({ walk: WALK(used) }), profile: {} } }), r);
    assert.equal(r.code, 200);
    advance(31 * 24 * 3600 * 1000);
    await media.sweep();
    assert.ok(media.info(used), 'прикреплённая лента осталась');
    assert.equal(media.info(orphan), null, 'неиспользованная удалена');
    assert.equal(media.info(photo), null, 'обычное фото живёт 30 дней как раньше');
    // без связи с объявлениями (старт сервера) ленты не трогаем
    const m2 = new MediaStore({ dataDir: media.dir.replace(/media$/, ''), logger: silent, now: () => Date.now() + 99 * 24 * 3600 * 1000 });
    m2.items = { ...media.items };
    await m2.sweep();
    assert.ok(m2.items[used]);
});
