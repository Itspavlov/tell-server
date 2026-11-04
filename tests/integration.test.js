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
