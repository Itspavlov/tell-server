'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountStore, nameKey } = require('../src/accounts');
const { DmStore } = require('../src/dm');
const { GroupStore, AdReactions } = require('../src/groups');
const { createSocketLayer } = require('../src/sockets');
const { PushStore, createPushSender, cleanSubscription } = require('../src/push');
const { createNotifier } = require('../src/notify');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { ListingStore } = require('../src/listings');
const { makeCfg, makeStore, makeIo, makeSocket, limiters, silent } = require('./helpers');

const PW = 'correct horse 9';
const KEY = 'B'.repeat(87), AUTH = 'a'.repeat(22);
const sub = (n = 1) => ({ endpoint: 'https://push.example.com/send/' + n, keys: { p256dh: KEY, auth: AUTH } });
const call = (s, ev, data) => new Promise(r => (data === undefined ? s.fire(ev, r) : s.fire(ev, data, r)));
const res = () => { const r = { code: 200, body: null }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.set = () => r; return r; };
const req = (o = {}) => ({ ip: '4.4.4.4', params: {}, query: {}, headers: {}, body: {}, ...o });

function fakeLib() {
    const calls = []; let fail = null;
    return { calls, setFail: (f) => { fail = f; }, setVapidDetails() {}, async sendNotification(s, body, opt) { calls.push({ s, body, opt }); if (fail) throw fail; } };
}

async function setup() {
    const cfg = makeCfg();
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const dms = new DmStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger: silent }); await dms.init();
    const groups = new GroupStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger: silent }); await groups.init();
    const adReacts = new AdReactions({ dataDir: cfg.dataDir, logger: silent }); await adReacts.init();
    const pushStore = new PushStore({ dataDir: cfg.dataDir, logger: silent }); await pushStore.init();
    const lib = fakeLib();
    const push = createPushSender({ store: pushStore, vapid: { publicKey: KEY, privateKey: 'k', subject: 'mailto:a@b.c' }, lib, logger: silent });
    const store = await makeStore(cfg);
    const io = makeIo();
    const notifier = createNotifier({ io, push, logger: silent });
    const lim = limiters(cfg);
    let n = 0;
    const layer = createSocketLayer({ io, cfg, store, accounts, dms, groups, adReacts, limiters: lim, notifier, logger: silent, newId: () => 'msg_' + (++n) });
    const connect = (token) => { const s = makeSocket({}); s.handshake.auth = token ? { token } : {}; layer.onConnection(s); return s; };
    const user = async (name) => { const r = await accounts.register(name, PW); return { token: r.token, id: r.user.id, sock: connect(r.token) }; };
    const pings = () => io.emitted.filter(e => e.ev === 'notify');
    return { cfg, accounts, dms, groups, pushStore, push, lib, store, io, notifier, lim, connect, user, pings };
}

test('push: подписка проверяется (только https, ключи нужного вида)', () => {
    assert.ok(cleanSubscription(sub()));
    assert.equal(cleanSubscription({ ...sub(), endpoint: 'http://push.example.com/x' }), null);
    assert.equal(cleanSubscription({ ...sub(), endpoint: 'javascript:alert(1)' }), null);
    assert.equal(cleanSubscription({ endpoint: sub().endpoint, keys: { p256dh: '<b>', auth: AUTH } }), null);
    assert.equal(cleanSubscription(null), null);
    assert.equal(cleanSubscription({ endpoint: 'https://x.y/' + 'a'.repeat(700), keys: sub().keys }), null);
});

test('push: хранилище — не больше 5 устройств, устройство переходит к новому пользователю, переживает перезапуск', async () => {
    const { pushStore, store } = await setup();
    for (let i = 1; i <= 7; i++) assert.equal((await pushStore.add('u1', sub(i))).ok, true);
    assert.equal(pushStore.forUser('u1').length, 5);
    assert.equal(pushStore.forUser('u1')[0].endpoint.endsWith('/3'), true);
    await pushStore.add('u2', sub(7));
    assert.equal(pushStore.forUser('u1').some(s => s.endpoint.endsWith('/7')), false);
    assert.equal(pushStore.forUser('u2').length, 1);
    assert.equal((await pushStore.add('u1', { endpoint: 'http://x/', keys: {} })).code, 'BAD_PAYLOAD');
    const again = new PushStore({ dataDir: pushStore.file.file.replace(/[\\/]push\.json$/, ''), logger: silent });
    await again.init();
    assert.equal(again.forUser('u2').length, 1);
    await store.close();
});

test('push: без ключей или библиотеки отключён и ничего не ломает', async () => {
    const { pushStore, store } = await setup();
    const off = createPushSender({ store: pushStore, vapid: { publicKey: '', privateKey: '' }, logger: silent });
    assert.equal(off.enabled(), false);
    assert.deepEqual(await off.send('u1', { title: 'x' }), { sent: 0 });
    const noLib = createPushSender({ store: pushStore, vapid: { publicKey: KEY, privateKey: 'k' }, logger: silent, lib: { setVapidDetails() { throw Object.assign(new Error('x'), { code: 'MODULE_NOT_FOUND' }); } } });
    assert.equal(noLib.enabled(), false);
    await store.close();
});

test('push: отправка на все устройства; мёртвые подписки (410) удаляются; слишком большое не отправляется', async () => {
    const { pushStore, push, lib, store } = await setup();
    await pushStore.add('u1', sub(1)); await pushStore.add('u1', sub(2));
    assert.deepEqual(await push.send('u1', { title: 'Привет', body: 'мир' }), { sent: 2 });
    assert.equal(lib.calls.length, 2);
    assert.equal(JSON.parse(lib.calls[0].body).title, 'Привет');
    lib.setFail(Object.assign(new Error('gone'), { statusCode: 410 }));
    await push.send('u1', { title: 'x' });
    assert.equal(pushStore.forUser('u1').length, 0, 'мёртвые подписки удалены');
    lib.setFail(Object.assign(new Error('boom'), { statusCode: 500 }));
    await pushStore.add('u1', sub(3));
    await push.send('u1', { title: 'x' });
    assert.equal(pushStore.forUser('u1').length, 1, 'временная ошибка подписку не удаляет');
    lib.calls.length = 0;
    assert.deepEqual(await push.send('u1', { body: 'я'.repeat(5000) }), { sent: 0 });
    assert.equal(lib.calls.length, 0);
    await store.close();
});

test('уведомления: личное сообщение — получателю баннер, отправителю нет; push только если получатель не в сети', async () => {
    const { user, pings, lib, pushStore, store, accounts, connect, io } = await setup();
    const a = await user('Аня'), b = await user('Борис');
    const o = await call(a.sock, 'dm-open', { ownerName: 'Борис' });
    await pushStore.add(b.id, sub(1));
    await call(a.sock, 'dm-send', { convId: o.conv.id, text: 'Привет, свободно?' });
    const p = pings();
    assert.equal(p.length, 1);
    assert.equal(p[0].room, 'user:' + b.id);
    assert.equal(p[0].payload.title, 'Аня');
    assert.equal(p[0].payload.body, 'Привет, свободно?');
    assert.equal(p[0].payload.open, 'dm:' + o.conv.id);
    assert.equal(lib.calls.length, 0, 'Борис в сети — push не нужен');
    b.sock.fire('disconnect');
    await call(a.sock, 'dm-send', { convId: o.conv.id, text: 'Алё?' });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(lib.calls.length, 1, 'Борис вышел — ушёл push');
    assert.equal(JSON.parse(lib.calls[0].body).body, 'Алё?');
    await store.close();
});

test('уведомления: группа — участникам (не автору), приглашение — приглашённому', async () => {
    const { user, pings, store } = await setup();
    const a = await user('Аня'), b = await user('Борис'), c = await user('Вера');
    const g = (await call(a.sock, 'group-create', { name: 'Отпуск 2027' })).group;
    await call(a.sock, 'group-invite', { groupId: g.id, name: 'Борис' });
    let inv = pings().filter(e => e.payload.kind === 'invite');
    assert.equal(inv.length, 1);
    assert.equal(inv[0].room, 'user:' + b.id);
    assert.ok(inv[0].payload.body.includes('Отпуск 2027'));
    await call(a.sock, 'group-send', { groupId: g.id, text: 'Куда едем?' });
    const gm = pings().filter(e => e.payload.kind === 'group');
    assert.deepEqual(gm.map(e => e.room), ['user:' + b.id]);
    assert.equal(gm[0].payload.title, 'Отпуск 2027');
    assert.equal(gm[0].payload.body, 'Аня: Куда едем?');
    assert.equal(pings().some(e => e.room === 'user:' + c.id), false, 'не участнику ничего');
    await store.close();
});

test('уведомления: ответили на сообщение зарегистрированного — ему баннер; гостю и самому себе нет', async () => {
    const { user, pings, store, connect } = await setup();
    const a = await user('Аня'), b = await user('Борис');
    a.sock.fire('join-room', 'housing'); b.sock.fire('join-room', 'housing');
    await call(a.sock, 'send-message', { room: 'housing', user: 'Аня', text: 'Кто сдаёт?', clientId: 'cid_aaaaaaaa01' });
    const first = (await store.getHistory('housing')).messages[0];
    await call(b.sock, 'send-message', { room: 'housing', user: 'Борис', text: 'Я сдаю', replyTo: first.id, clientId: 'cid_bbbbbbbb01' });
    const r = pings().filter(e => e.payload.kind === 'reply');
    assert.equal(r.length, 1);
    assert.equal(r[0].room, 'user:' + a.id);
    assert.equal(r[0].payload.title, 'Борис ответил(а) вам');
    assert.equal(r[0].payload.open, 'room:housing');
    const before = pings().length;
    const second = (await store.getHistory('housing')).messages[1];
    await call(b.sock, 'send-message', { room: 'housing', user: 'Борис', text: 'сам себе', replyTo: second.id, clientId: 'cid_bbbbbbbb02' });
    assert.equal(pings().length, before, 'ответ самому себе не уведомляет');
    await store.close();
});

test('push: эндпоинты ключа и подписки', async () => {
    const t = await setup();
    const admin = createAdmin({ token: '', dataDir: t.cfg.dataDir, logger: silent });
    const h = createHandlers({ cfg: t.cfg, store: t.store, admin, accounts: t.accounts, listings: null, limiters: t.lim, io: t.io, push: t.push, pushStore: t.pushStore, notifier: t.notifier, logger: silent });
    let r = res(); h.pushKey(req(), r);
    assert.equal(r.body.enabled, true); assert.equal(r.body.key, KEY);
    const u = await t.accounts.register('Аня', PW);
    const hdr = { authorization: 'Bearer ' + u.token };
    r = res(); await h.pushSubscribe(req({ body: { subscription: sub(1) } }), r); assert.equal(r.code, 401);
    r = res(); await h.pushSubscribe(req({ headers: hdr, body: { subscription: { endpoint: 'http://x', keys: {} } } }), r); assert.equal(r.code, 400);
    r = res(); await h.pushSubscribe(req({ headers: hdr, body: { subscription: sub(1) } }), r); assert.equal(r.code, 200);
    assert.equal(t.pushStore.forUser(u.user.id).length, 1);
    assert.equal(JSON.stringify(r.body).includes('push.example.com'), false, 'адрес подписки в ответе не возвращается');
    r = res(); await h.pushUnsubscribe(req({ headers: hdr, body: { endpoint: sub(1).endpoint } }), r); assert.equal(r.code, 200);
    assert.equal(t.pushStore.forUser(u.user.id).length, 0);
    // выключенный push
    const off = createPushSender({ store: t.pushStore, vapid: {}, logger: silent });
    const h2 = createHandlers({ cfg: t.cfg, store: t.store, admin, accounts: t.accounts, listings: null, limiters: t.lim, io: t.io, push: off, pushStore: t.pushStore, logger: silent });
    r = res(); h2.pushKey(req(), r); assert.deepEqual(r.body, { ok: true, enabled: false, key: '' });
    r = res(); await h2.pushSubscribe(req({ headers: hdr, body: { subscription: sub(2) } }), r); assert.equal(r.code, 404);
    await t.store.close();
});

test('уведомления: админ подтвердил хозяина и удалил объявление — владелец получает баннер', async () => {
    const t = await setup();
    const listings = new ListingStore({ dataDir: t.cfg.dataDir, accounts: t.accounts, limits: t.cfg.limits, logger: silent }); await listings.init();
    const TOKEN = 'c'.repeat(40);
    const admin = createAdmin({ token: TOKEN, dataDir: t.cfg.dataDir, logger: silent });
    const h = createHandlers({ cfg: t.cfg, store: t.store, admin, accounts: t.accounts, listings, limiters: t.lim, io: t.io, push: t.push, pushStore: t.pushStore, notifier: t.notifier, logger: silent });
    const u = await t.accounts.register('Хозяин', PW);
    const AH = { authorization: 'Bearer ' + TOKEN };
    let r = res(); await h.adminVerify(req({ headers: AH, body: { name: 'Хозяин', verified: true } }), r);
    assert.equal(r.code, 200);
    const v = t.pings().filter(e => e.payload.kind === 'verify');
    assert.equal(v.length, 1); assert.equal(v[0].room, 'user:' + u.user.id);
    const PNG = require('./helpers').PNG;
    const saved = await listings.save(t.accounts.authenticate(u.token), { ad: { type: 'rent', title: 'Студия', priceNum: 1, price: '1', location: 'Анапа', description: '', photos: [PNG], thumb: PNG, facts: [], amenities: [], terms: [], rules: [], coords: [44.9, 37.3], beach: [44.8, 37.3], busy: [], form: {} }, profile: { phone: '', about: '', avatar: '' } });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    r = res(); await h.adminDeleteListing(req({ headers: AH, params: { id: saved.listing.id } }), r);
    assert.equal(r.code, 200);
    const d = t.pings().filter(e => e.payload.kind === 'listing');
    assert.equal(d.length, 1); assert.ok(d[0].payload.body.includes('Студия'));
    await t.store.close();
});

test('уведомления: длинный текст обрезается, лишние пробелы убираются', () => {
    const io = makeIo();
    const n = createNotifier({ io, push: null, logger: silent });
    n.notify(['u1', 'u1'], { kind: 'dm', title: 'A'.repeat(200), body: '  много   пробелов\n\nи ' + 'я'.repeat(300) });
    assert.equal(io.emitted.length, 1, 'одному получателю — одно уведомление');
    assert.ok(io.emitted[0].payload.title.length <= 60);
    assert.ok(io.emitted[0].payload.body.length <= 140);
    assert.ok(io.emitted[0].payload.body.startsWith('много пробелов и'));
});
