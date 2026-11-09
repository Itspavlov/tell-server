'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountStore } = require('../src/accounts');
const { ServiceStore } = require('../src/services');
const { DvizStore } = require('../src/dviz');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { makeCfg, makeStore, makeIo, limiters, silent, PNG } = require('./helpers');

const PW = 'correct horse 9';
const TOKEN = 'd'.repeat(40);
const AH = { authorization: 'Bearer ' + TOKEN };
async function setup() {
    const cfg = makeCfg();
    const clock = { t: Date.parse('2027-06-10T09:00:00Z') };
    const now = () => clock.t;
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const services = new ServiceStore({ dataDir: cfg.dataDir, accounts, now, logger: silent }); await services.init();
    const dviz = new DvizStore({ dataDir: cfg.dataDir, accounts, services, now, logger: silent }); await dviz.init();
    const store = await makeStore(cfg);
    const io = makeIo();
    const sent = [];
    const notifier = { notify: (ids, p) => sent.push({ ids, p }) };
    const admin = createAdmin({ token: TOKEN, dataDir: cfg.dataDir, logger: silent });
    const h = createHandlers({ cfg, store, admin, accounts, services, dviz, limiters: limiters(cfg), io, notifier, logger: silent });
    const reg = async (n) => { const u = await accounts.register(n, PW); return { ...accounts.authenticate(u.token), token: u.token }; };
    return { clock, accounts, services, dviz, store, io, sent, h, reg };
}
const res = () => { const r = { code: 200, body: null }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.set = () => r; return r; };
const req = (o = {}) => ({ ip: '7.7.7.7', params: {}, query: {}, headers: {}, body: {}, ...o });
const as = (u) => ({ authorization: 'Bearer ' + u.token });
const DV = (o = {}) => ({ title: 'Джипы в горы', text: 'Едем на джипах к водопадам, есть 3 места', place: 'Набережная, у фонтана', when: '2027-06-12T10:00', max: 6, photos: [PNG, PNG], ...o });

test('движ: проверка полей и фото', async () => {
    const { dviz, reg, store } = await setup();
    const a = await reg('Анна');
    assert.equal((await dviz.create(a, DV({ title: '  ' }))).code, 'DVIZ_TITLE');
    assert.equal((await dviz.create(a, DV({ when: 'завтра' }))).code, 'DVIZ_WHEN');
    assert.equal((await dviz.create(a, DV({ when: '2027-06-01T10:00' }))).code, 'DVIZ_WHEN');          // в прошлом
    assert.equal((await dviz.create(a, DV({ when: '2029-01-01T10:00' }))).code, 'DVIZ_WHEN');          // слишком далеко
    assert.equal((await dviz.create(a, DV({ max: 1 }))).code, 'BAD_REQUEST');
    assert.equal((await dviz.create(a, DV({ photos: [PNG, PNG, PNG, PNG, PNG, PNG] }))).code, 'IMAGE_INVALID');
    assert.equal((await dviz.create(a, DV({ photos: ['data:image/png;base64,AAAA'] }))).code, 'IMAGE_INVALID');
    const ok = await dviz.create(a, DV({ photos: [PNG, PNG, PNG, PNG, PNG] }));
    assert.equal(ok.ok, true);
    assert.equal(ok.event.photos.length, 5);
    assert.ok(ok.event.thumb);
    const free = await dviz.create(a, { title: 'Просто потусить', text: '' });
    assert.equal(free.ok, true);                                                                      // время и место необязательны
    await store.close();
});

test('движ: точка сбора на карте', async () => {
    const { dviz, reg, store } = await setup();
    const a = await reg('Анна');
    const ok = await dviz.create(a, DV({ coords: [44.372251234, 38.531349999] }));
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.event.coords, [44.37225, 38.53135]);          // округляется до ~1 м
    assert.deepEqual(dviz.list()[0].coords, [44.37225, 38.53135]);    // и видна в ленте
    assert.equal((await dviz.create(a, DV({}))).event.coords, null);  // без точки — null
    for (const bad of [[100, 38], [44, 200], ['44', '38'], [44], [NaN, 1], 'x', { lat: 1 }]) {
        assert.equal((await dviz.create(a, DV({ coords: bad }))).code, 'BAD_REQUEST', JSON.stringify(bad));
    }
    await store.close();
});

test('движ: не больше 5 активных, лента и срок жизни', async () => {
    const { dviz, reg, clock, store } = await setup();
    const a = await reg('Анна');
    for (let i = 0; i < 5; i++) assert.equal((await dviz.create(a, DV({ title: 'Движ ' + i }))).ok, true);
    assert.equal((await dviz.create(a, DV())).code, 'TOO_MANY_DVIZ');
    assert.equal(dviz.list().length, 5);
    clock.t = Date.parse('2027-06-12T10:00:00+03:00') + 7 * 3600000;                                  // встреча прошла + 6 часов
    assert.equal(dviz.list().length, 0);
    assert.equal((await dviz.create(a, DV({ when: '2027-06-13T10:00' }))).ok, true);                  // слот освободился
    await store.close();
});

test('движ: закреплённая карточка развлечения', async () => {
    const { dviz, services, reg, store } = await setup();
    const a = await reg('Анна'), b = await reg('Борис');
    const sv = await services.save(a, { title: 'Морская прогулка', tag: 'sea', text: 'На катере', city: 'Архипо-Осиповка', price: 1500, unit: 'за человека', photos: [PNG] });
    const r = await dviz.create(b, DV({ attach: { id: sv.service.id } }));
    assert.equal(r.ok, true);
    assert.equal(r.event.attached.title, 'Морская прогулка');
    assert.equal(r.event.attached.price, 1500);
    assert.equal(r.event.attached.ownerName, 'Анна');
    assert.equal((await dviz.create(b, DV({ attach: { id: 's_nope' } }))).code, 'SERVICE_NOT_FOUND');
    await store.close();
});

test('движ: комментарии и отклики, уведомления автору', async () => {
    const { h, reg, dviz, sent, io, store } = await setup();
    const a = await reg('Анна'), b = await reg('Борис'), c = await reg('Вера');
    let r = res(); await h.dvizCreate(req({ headers: as(a), body: DV() }), r);
    assert.equal(r.code, 200);
    const id = r.body.event.id;
    assert.ok(io.emitted.some(e => e.ev === 'dviz-changed'));

    // гость видит ленту, но писать и откликаться без входа нельзя
    r = res(); await h.dvizList(req(), r);
    assert.equal(r.body.events.length, 1);
    assert.equal(r.body.events[0].photos, undefined);                                                 // в ленте без самих фото
    r = res(); await h.dvizComment(req({ params: { id }, body: { text: 'Я за!' } }), r);
    assert.equal(r.code, 401);
    r = res(); await h.dvizJoin(req({ params: { id } }), r);
    assert.equal(r.code, 401);

    r = res(); await h.dvizComment(req({ headers: as(b), params: { id }, body: { text: 'Я за! Сколько стоит?' } }), r);
    assert.equal(r.code, 200); assert.equal(r.body.comments, 1);
    assert.equal(sent.at(-1).ids[0], a.id);
    r = res(); await h.dvizComment(req({ headers: as(b), params: { id }, body: { text: '   ' } }), r);
    assert.equal(r.code, 400);

    r = res(); await h.dvizJoin(req({ headers: as(b), params: { id } }), r);
    assert.equal(r.code, 200); assert.equal(r.body.joined, true); assert.equal(r.body.joins, 1);
    assert.match(sent.at(-1).p.body, /Борис/);
    r = res(); await h.dvizJoin(req({ headers: as(a), params: { id } }), r);                          // свой движ
    assert.equal(r.code, 409);
    r = res(); await h.dvizGet(req({ headers: as(b), params: { id } }), r);
    assert.equal(r.body.event.joined, true);
    assert.equal(r.body.event.joinList[0].name, 'Борис');
    assert.equal(r.body.event.commentList[0].text, 'Я за! Сколько стоит?');
    r = res(); await h.dvizGet(req({ headers: as(c), params: { id } }), r);
    assert.equal(r.body.event.joined, false);
    r = res(); await h.dvizJoin(req({ headers: as(b), params: { id } }), r);                          // повтор снимает отклик
    assert.equal(r.body.joined, false); assert.equal(r.body.joins, 0);

    // удалить комментарий: автор комментария или автор движа, не посторонний
    const cid = dviz.get(id).commentList[0].id;
    r = res(); await h.dvizCommentDelete(req({ headers: as(c), params: { id, cid } }), r);
    assert.equal(r.code, 403);
    r = res(); await h.dvizCommentDelete(req({ headers: as(a), params: { id, cid } }), r);
    assert.equal(r.code, 200);
    assert.equal(dviz.get(id).commentList.length, 0);
    await store.close();
});

test('движ: «мест нет», удаление автором и модератором', async () => {
    const { h, reg, dviz, store } = await setup();
    const a = await reg('Анна'), b = await reg('Борис'), c = await reg('Вера');
    const e = (await dviz.create(a, DV({ max: 2 }))).event;
    assert.equal((await dviz.toggleJoin(b, e.id)).ok, true);
    assert.equal((await dviz.toggleJoin(c, e.id)).ok, true);
    const d = await reg('Дима');
    assert.equal((await dviz.toggleJoin(d, e.id)).code, 'DVIZ_FULL');

    let r = res(); await h.dvizDelete(req({ headers: as(b), params: { id: e.id } }), r);
    assert.equal(r.code, 403);
    // модератор: нужен токен, удаление пишется в журнал
    r = res(); await h.adminDvizDelete(req({ params: { id: e.id } }), r);
    assert.equal(r.code, 401);
    r = res(); await h.adminDviz(req({ headers: AH }), r);
    assert.equal(r.body.events.length, 1);
    r = res(); await h.adminDvizDelete(req({ headers: AH, params: { id: e.id } }), r);
    assert.equal(r.code, 200);
    assert.equal(dviz.get(e.id), null);
    r = res(); await h.dvizDelete(req({ headers: as(a), params: { id: e.id } }), r);
    assert.equal(r.code, 404);
    await store.close();
});

test('движ: сохраняется после перезапуска, смена имени обновляет карточки', async () => {
    const { dviz, accounts, reg, store } = await setup();
    const a = await reg('Анна');
    const e = (await dviz.create(a, DV())).event;
    await dviz.comment(a, e.id, 'Жду всех');
    const again = new DvizStore({ dataDir: dviz.file.file ? require('path').dirname(dviz.file.file) : '.', accounts, now: dviz.now, logger: silent });
    await again.init();
    assert.equal(again.get(e.id).commentList[0].text, 'Жду всех');
    assert.equal(await dviz.renameOwner(a.id, 'Анна2') > 0, true);
    await store.close();
});
