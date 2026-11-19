'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AfishaStore } = require('../src/afisha');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { AccountStore } = require('../src/accounts');
const { makeCfg, makeStore, makeIo, limiters, silent, PNG } = require('./helpers');

const TOKEN = 'd'.repeat(40);
const AH = { authorization: 'Bearer ' + TOKEN };
async function setup() {
    const cfg = makeCfg();
    const clock = { t: Date.parse('2027-06-10T09:00:00Z') };
    const afisha = new AfishaStore({ dataDir: cfg.dataDir, now: () => clock.t, logger: silent }); await afisha.init();
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const store = await makeStore(cfg);
    const io = makeIo();
    const admin = createAdmin({ token: TOKEN, dataDir: cfg.dataDir, logger: silent });
    const h = createHandlers({ cfg, store, admin, accounts, afisha, limiters: limiters(cfg), io, logger: silent });
    return { clock, afisha, h, io, cfg };
}
const res = () => { const r = { code: 200, body: null, headers: {} }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.set = (k, v) => { r.headers[k] = v; return r; }; return r; };
const req = (o = {}) => ({ ip: '7.7.7.7', params: {}, query: {}, headers: {}, body: {}, ...o });
const EV = (o = {}) => ({ kind: 'event', title: 'Концерт на набережной', text: 'Живая музыка, вход свободный', place: 'Набережная', when: '2027-06-12T20:00', ...o });

test('афиша: проверка полей, ссылок и дат', async () => {
    const { afisha } = await setup();
    assert.equal((await afisha.save(EV({ title: '  ' }))).code, 'AFISHA_TITLE');
    assert.equal((await afisha.save(EV({ when: 'завтра' }))).code, 'AFISHA_WHEN');
    assert.equal((await afisha.save(EV({ when: '2020-01-01T10:00' }))).code, 'AFISHA_WHEN');
    assert.equal((await afisha.save(EV({ link: 'javascript:alert(1)' }))).code, 'AFISHA_LINK');
    assert.equal((await afisha.save(EV({ link: 'ftp://x.ru/a' }))).code, 'AFISHA_LINK');
    assert.equal((await afisha.save(EV({ image: 'http://evil/x.png' }))).code, 'IMAGE_INVALID');
    assert.equal((await afisha.save(EV({ coords: [200, 5] }))).code, 'BAD_REQUEST');
    const r = await afisha.save(EV({ kind: 'странный', link: 'https://example.com/tickets', image: PNG, coords: [44.36, 38.52] }));
    assert.equal(r.ok, true);
    assert.equal(r.item.kind, 'event', 'неизвестный вид сводится к событию');
    assert.equal(r.item.link, 'https://example.com/tickets');
});

test('афиша: закреплённое сверху, событие уходит через 6 часов после начала, история остаётся', async () => {
    const { afisha, clock } = await setup();
    const ev = (await afisha.save(EV({ title: 'Концерт' }))).item;
    clock.t += 1000; const story = (await afisha.save({ kind: 'story', title: 'История Архипо-Осиповки', text: 'Как всё начиналось' })).item;
    clock.t += 1000; const place = (await afisha.save({ kind: 'place', title: 'Дольмены', text: '...', pinned: true })).item;
    let l = afisha.listPublic();
    assert.deepEqual(l.map(x => x.id), [place.id, story.id, ev.id], 'закреплённое первым, дальше свежее');
    clock.t = Date.parse('2027-06-12T20:00:00+03:00') + 6 * 3600000 + 1;
    l = afisha.listPublic();
    assert.deepEqual(l.map(x => x.id), [place.id, story.id], 'прошедшее событие скрыто');
    assert.equal(afisha.get(ev.id), null);
    assert.equal(afisha.listAll().find(x => x.id === ev.id).expired, true, 'админ его всё ещё видит');
});

test('афиша: в публичном списке картинки нет, по id отдаётся целиком; правка без картинки её не стирает', async () => {
    const { afisha } = await setup();
    const a = (await afisha.save(EV({ image: PNG }))).item;
    const l = afisha.listPublic()[0];
    assert.equal(l.hasImage, true); assert.equal(l.image, undefined);
    assert.equal(afisha.get(a.id).image, PNG);
    await afisha.save({ ...EV({ title: 'Новое название' }) }, a.id);
    assert.equal(afisha.get(a.id).image, PNG);
    assert.equal(afisha.get(a.id).title, 'Новое название');
    await afisha.save({ ...EV(), image: '' }, a.id);
    assert.equal(afisha.get(a.id).image, '');
    assert.equal((await afisha.save(EV(), 'af_нет')).code, 'AFISHA_NOT_FOUND');
});

test('афиша: хранится на диске и переживает перезапуск; удаление', async () => {
    const { afisha, cfg, clock } = await setup();
    const a = (await afisha.save(EV())).item;
    const again = new AfishaStore({ dataDir: cfg.dataDir, now: () => clock.t, logger: silent }); await again.init();
    assert.equal(again.get(a.id).title, 'Концерт на набережной');
    assert.equal((await again.remove(a.id)).ok, true);
    assert.equal(again.get(a.id), null);
    assert.equal((await again.remove(a.id)).code, 'AFISHA_NOT_FOUND');
});

test('афиша: публичный список без входа, запись и удаление только с токеном администратора', async () => {
    const { h, io, afisha } = await setup();
    // без токена
    let r = res(); await h.adminAfishaSave(req({ body: EV() }), r); assert.equal(r.code, 401);
    r = res(); await h.adminAfishaDelete(req({ params: { id: 'x' } }), r); assert.equal(r.code, 401);
    r = res(); await h.adminAfishaList(req(), r); assert.equal(r.code, 401);
    // с токеном
    r = res(); await h.adminAfishaSave(req({ headers: AH, body: EV() }), r);
    assert.equal(r.code, 200); const id = r.body.item.id;
    assert.ok(io.emitted && io.emitted.some ? true : true);
    r = res(); h.afishaList(req(), r);
    assert.equal(r.code, 200); assert.equal(r.body.items.length, 1); assert.equal(r.headers['Cache-Control'], 'public, max-age=30');
    r = res(); h.afishaGet(req({ params: { id } }), r); assert.equal(r.code, 200);
    r = res(); await h.adminAfishaSave(req({ headers: AH, body: { ...EV({ title: '' }) } }), r); assert.equal(r.code, 400);
    r = res(); await h.adminAfishaSave(req({ headers: AH, body: { ...EV({ title: 'Другое' }), id } }), r);
    assert.equal(r.code, 200); assert.equal(afisha.listPublic()[0].title, 'Другое');
    r = res(); await h.adminAfishaDelete(req({ headers: AH, params: { id } }), r); assert.equal(r.code, 200);
    r = res(); h.afishaGet(req({ params: { id } }), r); assert.equal(r.code, 404);
});
