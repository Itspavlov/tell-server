'use strict';
// ВНИМАНИЕ: этот тест использует настоящие express и socket.io.
// Он НЕ запускался автором в среде разработки (там нельзя установить пакеты).
// Запуск у вас: npm install && npm run test:integration
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: connect } = require('socket.io-client');
const { start } = require('../server');

const PORT = 3457;
const URL = `http://127.0.0.1:${PORT}`;
const TOKEN = 'integration-token-' + 'x'.repeat(30);
const quiet = { info() {}, warn() {}, error() {} };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let srv; let dir;
test.before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tell-int-'));
    srv = await start({ PORT: String(PORT), NODE_ENV: 'development', DATA_DIR: dir, ADMIN_TOKEN: TOKEN }, quiet);
});
test.after(async () => {
    srv.io.close();
    await srv.store.close();
    srv.server.close();
});

const client = () => new Promise((res, rej) => {
    const s = connect(URL, { transports: ['websocket'], forceNew: true });
    s.on('connect', () => res(s)); s.on('connect_error', rej);
});
const emitAck = (s, ev, data) => new Promise(r => s.emit(ev, data, r));

test('HTTP: корень, healthz, readyz', async () => {
    assert.equal((await (await fetch(URL + '/')).json()).status, 'ok');
    assert.equal((await fetch(URL + '/healthz')).status, 200);
    assert.equal((await fetch(URL + '/readyz')).status, 200);
});

test('сообщение доходит до второго клиента, с room и id; ack получен', async () => {
    const a = await client(); const b = await client();
    await emitAck(a, 'join-room', 'housing'); await emitAck(b, 'join-room', 'housing');
    const got = new Promise(r => b.once('new-message', r));
    const ack = await emitAck(a, 'send-message', { room: 'housing', user: 'Тарас', text: 'привет', clientId: 'int-test-0001' });
    const msg = await got;
    assert.equal(ack.ok, true);
    assert.equal(msg.room, 'housing');
    assert.equal(msg.id, ack.id);
    a.close(); b.close();
});

test('clear-room через сокет ничего не удаляет', async () => {
    const a = await client();
    await emitAck(a, 'join-room', 'work');
    await emitAck(a, 'send-message', { room: 'work', user: 'Тарас', text: 'не удалять', clientId: 'int-test-0002' });
    a.emit('clear-room', 'work');
    await new Promise(r => setTimeout(r, 300));
    const j = await (await fetch(URL + '/api/messages/work')).json();
    assert.equal(j.messages.length, 1);
    a.close();
});

test('DELETE без токена 401, с токеном 200', async () => {
    assert.equal((await fetch(URL + '/api/messages/work', { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(URL + '/api/messages/work', { method: 'DELETE', headers: { Authorization: 'Bearer ' + TOKEN } })).status, 200);
});

test('чужой Origin не может подключиться по сокету', async () => {
    await new Promise((res) => {
        const s = connect(URL, { transports: ['websocket'], forceNew: true, extraHeaders: { Origin: 'https://evil.example' } });
        s.on('connect', () => { s.close(); assert.fail('подключился с чужого Origin'); });
        s.on('connect_error', () => { s.close(); res(); });
    });
});

test('фото принимается; поддельное фото отклоняется', async () => {
    const a = await client();
    await emitAck(a, 'join-room', 'market');
    assert.equal((await emitAck(a, 'send-message', { room: 'market', user: 'Тарас', image: PNG, clientId: 'int-test-0003' })).ok, true);
    const bad = await emitAck(a, 'send-message', { room: 'market', user: 'Тарас', image: 'data:image/png;base64,' + Buffer.from('<html>').toString('base64'), clientId: 'int-test-0004' });
    assert.equal(bad.ok, false);
    a.close();
});

// ---- аккаунты, личные сообщения, реакции (тоже не запускалось автором) ----
const post = (p, body) => fetch(URL + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
const authed = (token) => new Promise((res, rej) => {
    const s = connect(URL, { transports: ['websocket'], forceNew: true, auth: { token } });
    s.on('connect', () => res(s)); s.on('connect_error', rej);
});

test('регистрация и вход по HTTP', async () => {
    const r = await post('/api/auth/register', { name: 'ИнтТест', password: 'password123' });
    assert.equal(r.status, 201);
    assert.equal((await post('/api/auth/register', { name: 'инттест', password: 'password123' })).status, 409);
    assert.equal((await post('/api/auth/login', { name: 'ИнтТест', password: 'wrongwrong' })).status, 401);
    assert.equal((await post('/api/auth/login', { name: 'ИнтТест', password: 'password123' })).status, 200);
});

test('личные сообщения между двумя аккаунтами, посторонний не видит', async () => {
    const a = (await post('/api/auth/register', { name: 'ГостьИнт', password: 'password123' })).body;
    const o = (await post('/api/auth/register', { name: 'ХозяинИнт', password: 'password123' })).body;
    const x = (await post('/api/auth/register', { name: 'ПосторонийИнт', password: 'password123' })).body;
    const sa = await authed(a.token), so = await authed(o.token), sx = await authed(x.token);
    const opened = await emitAck(sa, 'dm-open', { ownerName: 'ХозяинИнт', adId: 'h-1', adTitle: 'Квартира' });
    assert.equal(opened.ok, true);
    const got = new Promise(r => so.once('dm-message', r));
    assert.equal((await emitAck(sa, 'dm-send', { convId: opened.conv.id, text: 'Здравствуйте', clientId: 'dm-int-0001' })).ok, true);
    assert.equal((await got).text, 'Здравствуйте');
    assert.equal((await emitAck(sx, 'dm-history', { convId: opened.conv.id })).ok, false);
    [sa, so, sx].forEach(s => s.close());
});

test('реакция и ответ в общем чате', async () => {
    const a = await client();
    await emitAck(a, 'join-room', 'trips');
    const first = await emitAck(a, 'send-message', { room: 'trips', user: 'РеактИнт', text: 'едем?', clientId: 'int-test-0010' });
    const upd = new Promise(r => a.once('reaction-update', r));
    const r = await emitAck(a, 'react', { room: 'trips', id: first.id, emoji: '🔥', user: 'РеактИнт' });
    assert.deepEqual(r.reactions, { '🔥': 1 });
    assert.deepEqual((await upd).reactions, { '🔥': 1 });
    const gotMsg = new Promise(res => a.once('new-message', res));
    await emitAck(a, 'send-message', { room: 'trips', user: 'РеактИнт', text: 'я за', replyTo: first.id, clientId: 'int-test-0011' });
    assert.equal((await gotMsg).reply.id, first.id);
    a.close();
});
