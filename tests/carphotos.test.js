'use strict';
// Фото автомобиля (до 3) в карточке «Предлагаю поездку»
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AccountStore } = require('../src/accounts');
const { RequestStore, cleanRequest } = require('../src/requests');
const { MediaStore } = require('../src/media');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { makeCfg, makeStore, makeIo, limiters, silent } = require('./helpers');

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1500, 7)]);
const res = () => { const r = { code: 200, body: null }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.set = () => r; return r; };
const rq = (tok, o = {}) => ({ ip: '6.6.6.6', params: {}, query: {}, headers: tok ? { authorization: 'Bearer ' + tok } : {}, body: {}, ...o });

let cooldownReset = () => {};
async function setup() {
    const cfg = makeCfg();
    const clock = { t: Date.parse('2027-03-10T12:00:00Z') }; const now = () => clock.t;
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent, now }); await accounts.init();
    const requests = new RequestStore({ dataDir: cfg.dataDir, limits: cfg.limits, now, logger: silent }); await requests.init();
    const media = new MediaStore({ dataDir: cfg.dataDir, logger: silent, now }); await media.init();
    const store = await makeStore(cfg);
    const admin = createAdmin({ token: 'c'.repeat(40), dataDir: cfg.dataDir, logger: silent });
    const h = createHandlers({ cfg, store, admin, accounts, requests, media, limiters: limiters(cfg, now), io: makeIo(), logger: silent });
    const reg = async (n) => { const r = await accounts.register(n, 'correct horse 9'); return { id: r.user.id, token: r.token }; };
    const photo = async (u) => (await media.save(u.id, JPG, 0, 'photo')).id;
    cooldownReset = () => { clock.t += 61000; };
    return { cfg, clock, accounts, requests, media, h, reg, photo };
}
const card = (extra = {}) => ({ section: 'trips', kind: 'offer', title: 'Еду в Краснодар', city: 'Архипо-Осиповка', guests: 3, budget: 1500, text: 'Мерседес w222', ...extra });
const today = '2027-03-10';

test('cleanRequest: фото только у «Предлагаю поездку», не больше трёх, только id файлов', () => {
    const a = 'vm_' + 'a'.repeat(32), b = 'vm_' + 'b'.repeat(32), c = 'vm_' + 'c'.repeat(32), d = 'vm_' + 'd'.repeat(32);
    assert.deepEqual(cleanRequest(card({ photos: [a, b, a] }), today).value.photos, [a, b]);
    assert.equal(cleanRequest(card({ photos: [a, b, c, d] }), today).ok, false);
    assert.equal(cleanRequest(card({ photos: ['http://evil/x.png'] }), today).ok, false);
    assert.equal(cleanRequest(card({ photos: 'vm_x' }), today).ok, false);
    assert.equal('photos' in cleanRequest(card(), today).value, false);                            // не прислали: ключа нет (при правке фото сохраняются)
    assert.equal('photos' in cleanRequest(card({ kind: 'seek', photos: [a] }), today).value, false);      // «Ищу поездку» без фото
    assert.equal('photos' in cleanRequest(card({ section: 'work', photos: [a] }), today).value, false);
});

test('создание с фото: свои файлы принимаются, чужие и выдуманные — нет', async () => {
    const { h, reg, photo, requests } = await setup();
    const u = await reg('Водитель'), v = await reg('Другой');
    const mine = [await photo(u), await photo(u), await photo(u)];
    const alien = await photo(v);
    const bad = res(); await h.requestCreate(rq(u.token, { body: card({ photos: [mine[0], alien] }) }), bad);
    assert.equal(bad.code, 400); assert.equal(bad.body.code, 'IMAGE_INVALID');
    const junk = res(); await h.requestCreate(rq(u.token, { body: card({ photos: ['http://evil/x.png'] }) }), junk);
    assert.equal(junk.code, 400);                                                                  // не id файла
    const gone = res(); await h.requestCreate(rq(u.token, { body: card({ photos: ['vm_' + '0'.repeat(32), mine[0]] }) }), gone);
    assert.equal(gone.code, 200); assert.deepEqual(gone.body.request.photos, [mine[0]]);           // файла уже нет: пропускаем, остальное сохраняем
    await h.requestDelete(rq(u.token, { params: { id: gone.body.request.id } }), res());
    mine[0] = await photo(u);                                                                      // (удаление карточки стёрло её фото)
    cooldownReset();
    const four = res(); await h.requestCreate(rq(u.token, { body: card({ photos: [...mine, await photo(u)] }) }), four);
    assert.equal(four.code, 400);
    const ok = res(); await h.requestCreate(rq(u.token, { body: card({ photos: mine }) }), ok);
    assert.equal(ok.code, 200); assert.deepEqual(ok.body.request.photos, mine);
    const list = res(); await h.requestsList(rq(null, { query: { section: 'trips', status: 'active' } }), list);
    assert.deepEqual(list.body.requests[0].photos, mine);
});

test('правка: удалённые фото стираются с диска, без поля photos фото остаются', async () => {
    const { h, reg, photo, media } = await setup();
    const u = await reg('Водитель');
    const [p1, p2, p3] = [await photo(u), await photo(u), await photo(u)];
    const c = res(); await h.requestCreate(rq(u.token, { body: card({ photos: [p1, p2] }) }), c);
    const id = c.body.request.id;
    const file = (pid) => path.join(media.dir, pid + '.jpg');
    assert.ok(fs.existsSync(file(p1)));
    const keep = res(); await h.requestEdit(rq(u.token, { params: { id }, body: card({ title: 'Еду в Краснодар завтра' }) }), keep);
    assert.deepEqual(keep.body.request.photos, [p1, p2]);                                            // старый клиент без photos ничего не стирает
    const swap = res(); await h.requestEdit(rq(u.token, { params: { id }, body: card({ title: 'Еду в Краснодар завтра', photos: [p2, p3] }) }), swap);
    assert.deepEqual(swap.body.request.photos, [p2, p3]);
    await new Promise(r => setTimeout(r, 30));
    assert.equal(fs.existsSync(file(p1)), false); assert.ok(fs.existsSync(file(p2)));
    const del = res(); await h.requestDelete(rq(u.token, { params: { id } }), del);
    await new Promise(r => setTimeout(r, 30));
    assert.equal(del.code, 200); assert.equal(fs.existsSync(file(p2)), false); assert.equal(fs.existsSync(file(p3)), false);
    assert.equal(media.get(p2), null);
});

test('чужую карточку с фото править нельзя; «ищу поездку» фото не получает', async () => {
    const { h, reg, photo } = await setup();
    const u = await reg('Водитель'), v = await reg('Пассажир');
    const p = await photo(u);
    const c = res(); await h.requestCreate(rq(u.token, { body: card({ photos: [p] }) }), c);
    const x = res(); await h.requestEdit(rq(v.token, { params: { id: c.body.request.id }, body: card({ photos: [await photo(v)] }) }), x);
    assert.equal(x.code >= 400, true);
    const s = res(); await h.requestCreate(rq(v.token, { body: card({ kind: 'seek', title: 'Ищу машину', photos: [await photo(v)] }) }), s);
    assert.equal(s.code, 200); assert.deepEqual(s.body.request.photos, []);
});
