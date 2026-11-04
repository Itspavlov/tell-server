'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSocketLayer } = require('../src/sockets');
const { makeCfg, makeStore, makeIo, makeSocket, limiters, PNG, silent } = require('./helpers');

async function setup(envOver = {}) {
    const cfg = makeCfg({ env: envOver });
    const store = await makeStore(cfg);
    const io = makeIo();
    let t = 1_000_000;
    const now = () => t;
    const lim = limiters(cfg, now);
    let n = 0;
    const layer = createSocketLayer({ io, cfg, store, limiters: lim, logger: silent, now, newId: () => 'msg_' + (++n) });
    const connect = (opts) => { const s = makeSocket(opts); layer.onConnection(s); return s; };
    return { cfg, store, io, layer, connect, advance: (ms) => { t += ms; }, lim };
}
const data = (o = {}) => ({ room: 'housing', user: 'Тарас', text: 'привет', clientId: 'cid-' + Math.random().toString(36).slice(2, 12), ...o });
const send = (s, d) => new Promise((res) => s.fire('send-message', d, res));
const join = (s, room = 'housing') => new Promise((res) => s.fire('join-room', room, res));

test('новый клиент получает server-hello protocol 2', async () => {
    const { connect } = await setup();
    assert.deepEqual(connect().sent('server-hello')[0], { protocol: 2, user: null });
});

test('join-room отдаёт историю массивом (как раньше), неверная комната отклоняется', async () => {
    const { connect, store } = await setup();
    const a = connect();
    await join(a);
    assert.ok(Array.isArray(a.sent('room-history')[0]));
    const r = await join(a, 'dm_1_2');
    assert.equal(r.code, 'INVALID_ROOM');
    assert.equal(a.rooms.has('dm_1_2'), false);
    await store.close();
});

test('отправка: ack с id, рассылка new-message содержит room', async () => {
    const { connect, io, store } = await setup();
    const a = connect(); await join(a);
    const r = await send(a, data());
    assert.equal(r.ok, true);
    assert.equal(r.id, 'msg_1');
    const ev = io.emitted.find(e => e.ev === 'new-message');
    assert.equal(ev.room, 'housing');
    assert.equal(ev.payload.room, 'housing');
    assert.equal(ev.payload.id, 'msg_1');
    assert.equal(ev.payload.avatar, 'Т');
    await store.close();
});

test('подделанный avatar игнорируется, аватар строится сервером', async () => {
    const { connect, io, store } = await setup();
    const a = connect(); await join(a);
    await send(a, data({ avatar: '<img src=x onerror=alert(1)>' }));
    assert.equal(io.emitted[0].payload.avatar, 'Т');
    await store.close();
});

test('clear-room через сокет больше не работает и считается нарушением', async () => {
    const { connect, io, store } = await setup();
    const a = connect(); await join(a);
    await send(a, data());
    await a.fire('clear-room', 'housing');
    assert.equal(store.stats().rooms.housing, 1, 'история на месте');
    assert.equal(io.emitted.filter(e => e.ev === 'room-cleared').length, 0);
    await store.close();
});

test('чужую комнату нельзя: не вошёл — NOT_IN_ROOM (клиент с ack)', async () => {
    const { connect, store } = await setup();
    const a = connect();
    const r = await send(a, data());
    assert.equal(r.code, 'NOT_IN_ROOM');
    assert.equal(store.stats().rooms.housing, 0);
    await store.close();
});

test('старый клиент без ack и clientId не теряет сообщения (автовход)', async () => {
    const { connect, store, io } = await setup();
    const a = connect();
    await a.fire('send-message', { room: 'housing', user: 'Тарас', text: 'привет от старого клиента', avatar: 'Т', image: null });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(store.stats().rooms.housing, 1);
    assert.equal(io.emitted[0].ev, 'new-message');
    await store.close();
});

test('старый клиент получает send-error при ошибке', async () => {
    const { connect, store } = await setup();
    const a = connect();
    await a.fire('send-message', { room: 'housing', user: 'x', text: 'привет' });
    assert.equal(a.sent('send-error')[0].code, 'INVALID_NAME');
    await store.close();
});

test('валидация: плохие данные не доходят до хранилища', async () => {
    const { connect, store } = await setup();
    const a = connect(); await join(a);
    for (const bad of [null, 'x', 5, [], {}, data({ user: 'Admin' }), data({ text: 'a'.repeat(1001) }), data({ image: 'javascript:1' }), data({ room: 'x' })]) {
        const r = await send(a, bad);
        assert.equal(r.ok, false);
    }
    assert.equal(store.stats().rooms.housing, 0);
    await store.close();
});

test('картинка принимается и отдаётся', async () => {
    const { connect, io, store } = await setup();
    const a = connect(); await join(a);
    const r = await send(a, data({ text: '', image: PNG }));
    assert.equal(r.ok, true);
    assert.equal(io.emitted[0].payload.image, PNG);
    await store.close();
});

test('идемпотентность: повтор с тем же clientId — один ack, одно сообщение, одна рассылка', async () => {
    const { connect, io, store } = await setup();
    const a = connect(); await join(a);
    const d = data({ clientId: 'retry-12345678' });
    const r1 = await send(a, d);
    const r2 = await send(a, d);
    assert.equal(r1.id, r2.id);
    assert.equal(r2.duplicate, true);
    assert.equal(store.stats().rooms.housing, 1);
    assert.equal(io.emitted.filter(e => e.ev === 'new-message').length, 1);
    await store.close();
});

test('спам: одинаковый текст подряд отклоняется, через 5 секунд можно', async () => {
    const { connect, advance, store } = await setup();
    const a = connect(); await join(a);
    assert.equal((await send(a, data({ text: 'Куплю' }))).ok, true);
    assert.equal((await send(a, data({ text: 'куплю' }))).code, 'DUPLICATE_TEXT');
    advance(5001);
    assert.equal((await send(a, data({ text: 'Куплю' }))).ok, true);
    await store.close();
});

test('спам: лимит 10 сообщений за 10 секунд на сокет', async () => {
    const { connect, store } = await setup();
    const a = connect(); await join(a);
    let blocked = 0;
    for (let i = 0; i < 14; i++) if ((await send(a, data({ text: 'сообщение номер ' + i }))).code === 'RATE_LIMITED') blocked++;
    assert.equal(blocked, 4);
    await store.close();
});

test('спам: лимит по IP работает при смене сокетов', async () => {
    const { connect, store } = await setup();
    let ok = 0;
    for (let i = 0; i < 12; i++) {
        const s = connect({ ip: '5.5.5.5' }); await join(s);
        for (let j = 0; j < 8; j++) {
            if ((await send(s, data({ text: `текст ${i}-${j}` }))).ok) ok++;
        }
    }
    assert.ok(ok <= 60, 'принято ' + ok);
    await store.close();
});

test('лимит фото: не более 6 в минуту с одного IP', async () => {
    const { connect, store, advance } = await setup();
    let ok = 0;
    const a = connect(); await join(a);
    for (let i = 0; i < 9; i++) { advance(1100); if ((await send(a, data({ text: '', image: PNG }))).ok) ok++; }
    assert.equal(ok, 6);
    await store.close();
});

test('много нарушений — соединение закрывается', async () => {
    const { connect, store } = await setup();
    const a = connect();
    for (let i = 0; i < 8; i++) await a.fire('evil-event', {});
    assert.equal(a.disconnected, true);
    await store.close();
});

test('не более 25 соединений с одного IP; слот освобождается при отключении', async () => {
    const { connect, layer, store } = await setup();
    const socks = Array.from({ length: 25 }, () => connect({ ip: '7.7.7.7' }));
    const extra = connect({ ip: '7.7.7.7' });
    assert.equal(extra.disconnected, true);
    assert.equal(layer.connectionCount('7.7.7.7'), 25);
    socks[0].disconnect();
    assert.equal(layer.connectionCount('7.7.7.7'), 24);
    await store.close();
});

test('подделка X-Forwarded-For не даёт обойти лимит соединений', async () => {
    const { connect, store } = await setup();
    for (let i = 0; i < 25; i++) connect({ ip: '10.0.0.1', headers: { 'x-forwarded-for': `${i}.${i}.${i}.${i}, 203.0.113.9` } });
    const extra = connect({ ip: '10.0.0.1', headers: { 'x-forwarded-for': '8.8.8.8, 203.0.113.9' } });
    assert.equal(extra.disconnected, true);
    await store.close();
});

test('allowRequest: чужой Origin и запрос без Origin в production отклоняются', async () => {
    const { layer, store } = await setup({ NODE_ENV: 'production', ALLOW_NO_ORIGIN: 'false' });
    const run = (headers) => new Promise(res => layer.allowRequest({ headers, socket: { remoteAddress: '1.1.1.1' } }, (e, ok) => res(ok)));
    assert.equal(await run({ origin: 'https://gokurort-new.onrender.com' }), true);
    assert.equal(await run({ origin: 'https://evil.example' }), false);
    assert.equal(await run({}), false);
    await store.close();
});

test('allowRequest: лимит подключений в минуту', async () => {
    const { layer, store } = await setup();
    let ok = 0;
    for (let i = 0; i < 70; i++) await new Promise(res => layer.allowRequest({ headers: { origin: 'https://gokurort-new.onrender.com' }, socket: { remoteAddress: '2.2.2.2' } }, (e, o) => { if (o) ok++; res(); }));
    assert.equal(ok, 60);
    await store.close();
});

test('сбой записи: клиент получает STORE_UNAVAILABLE, рассылки нет', async () => {
    const { connect, store, io } = await setup();
    const a = connect(); await join(a);
    store.append = async () => { const { StoreError } = require('../src/store'); throw new StoreError('STORE_UNAVAILABLE'); };
    const r = await send(a, data());
    assert.equal(r.code, 'STORE_UNAVAILABLE');
    assert.equal(io.emitted.length, 0);
    await store.close();
});
