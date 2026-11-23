'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGameLayer } = require('../src/game');

// поддельный сокет: запоминает, что ему отправили, и умеет «получать» события от клиента
function makeSocket(address = '1.1.1.1') {
    const handlers = {}, got = [];
    return {
        handshake: { address, headers: {} },
        got, disconnected: false,
        on(ev, fn) { handlers[ev] = fn; },
        emit(ev, payload) { got.push([ev, payload]); },
        disconnect() { this.disconnected = true; if (handlers.disconnect) handlers.disconnect(); },
        fire(ev, data) { let res; if (handlers[ev]) handlers[ev](data, (r) => { res = r; }); return res; },
        last(ev) { const a = got.filter((g) => g[0] === ev); return a.length ? a[a.length - 1][1] : undefined; }
    };
}
function layer(opts = {}) {
    let t = 1_000_000;
    const L = createGameLayer({ cfg: {}, logger: { info() {}, warn() {} }, now: () => t, ...opts });
    L.tick = (ms) => { t += ms; };
    return L;
}
const connect = (L, addr) => { const s = makeSocket(addr); L.onConnection(s); return s; };

test('создание комнаты даёт код из 4 знаков и выбранную роль', () => {
    const L = layer(), a = connect(L);
    const r = a.fire('g-create', { role: 'buyer' });
    assert.equal(r.ok, true); assert.equal(r.role, 'buyer'); assert.match(r.code, /^[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(L.roomCount(), 1);
});

test('второй игрок получает свободную роль, первый узнаёт о нём', () => {
    const L = layer(), a = connect(L), b = connect(L, '2.2.2.2');
    const { code } = a.fire('g-create', { role: 'seller' });
    const r = b.fire('g-join', { code: code.toLowerCase() });
    assert.deepEqual([r.ok, r.role, r.peer, r.peerRole], [true, 'buyer', true, 'seller']);
    assert.deepEqual(a.last('g-peer'), { present: true, role: 'buyer' });
});

test('третьего в комнату не пускаем, чужой код — ошибка', () => {
    const L = layer(), a = connect(L), b = connect(L, '2.2.2.2'), c = connect(L, '3.3.3.3');
    const { code } = a.fire('g-create', { role: 'seller' });
    b.fire('g-join', { code });
    assert.equal(c.fire('g-join', { code }).code, 'full-room');
    assert.equal(c.fire('g-join', { code: 'ZZZZ' }).code, 'no-room');
});

test('состояние и реплики доходят только до напарника', () => {
    const L = layer(), a = connect(L), b = connect(L, '2.2.2.2');
    const { code } = a.fire('g-create', { role: 'seller' }); b.fire('g-join', { code });
    a.fire('g-s', { x: 1.234, z: -2, yaw: 0.5, m: 'walk', c: null, r: 1.8 });
    assert.deepEqual(b.last('g-s'), { x: 1.23, z: -2, yaw: 0.5, m: 'walk', c: null, r: 1.8 });
    assert.equal(a.last('g-s'), undefined);
    a.fire('g-ev', { t: 'say', text: '  Привет, <b>Лера</b>!  ' });
    assert.equal(b.last('g-ev').text, 'Привет, bЛера/b!');
    assert.equal(b.last('g-ev').text.includes('<'), false);
    b.fire('g-ev', { t: 'act', a: 'wave' });
    assert.deepEqual(a.last('g-ev'), { t: 'act', a: 'wave' });
});

test('мусор в состоянии отбрасывается: не числа, огромные координаты, чужие режимы и клипы', () => {
    const L = layer(), a = connect(L), b = connect(L, '2.2.2.2');
    const { code } = a.fire('g-create', { role: 'seller' }); b.fire('g-join', { code });
    a.fire('g-s', { x: 'a', z: 0, yaw: 0 });
    a.fire('g-s', { x: 1e9, z: 0, yaw: 0 });
    a.fire('g-s', { x: NaN, z: 0, yaw: 0 });
    assert.equal(b.last('g-s'), undefined);
    a.fire('g-s', { x: 1, z: 2, yaw: 3, m: 'hack', c: '../etc', r: 'x' });
    assert.deepEqual(b.last('g-s'), { x: 1, z: 2, yaw: 3, m: 'idle', c: null, r: 0 });
    a.fire('g-ev', { t: 'say', text: '' });
    a.fire('g-ev', { t: 'act', a: 'delete-everything' });
    assert.equal(b.last('g-ev'), undefined);
});

test('длинная реплика обрезается', () => {
    const L = layer(), a = connect(L), b = connect(L, '2.2.2.2');
    const { code } = a.fire('g-create', { role: 'seller' }); b.fire('g-join', { code });
    a.fire('g-ev', { t: 'say', text: 'я'.repeat(500) });
    assert.equal(b.last('g-ev').text.length, 80);
});

test('частота состояний ограничена', () => {
    const L = layer(), a = connect(L), b = connect(L, '2.2.2.2');
    const { code } = a.fire('g-create', { role: 'seller' }); b.fire('g-join', { code });
    for (let i = 0; i < 200; i++) a.fire('g-s', { x: i % 100, z: 0, yaw: 0, m: 'walk' });
    const n = b.got.filter((g) => g[0] === 'g-s').length;
    assert.ok(n <= 31, 'получено ' + n);
});

test('выход игрока сообщает напарнику, а вернуться можно в свою роль', () => {
    const L = layer(), a = connect(L), b = connect(L, '2.2.2.2');
    const { code } = a.fire('g-create', { role: 'seller' }); b.fire('g-join', { code });
    b.disconnect();
    assert.deepEqual(a.last('g-peer'), { present: false, role: 'buyer' });
    const b2 = connect(L, '2.2.2.2');
    const r = b2.fire('g-join', { code, want: 'buyer' });
    assert.deepEqual([r.ok, r.role, r.peer], [true, 'buyer', true]);
});

test('пустая комната живёт 10 минут, потом удаляется', () => {
    const L = layer(), a = connect(L);
    const { code } = a.fire('g-create', { role: 'seller' });
    a.disconnect();
    L.tick(5 * 60_000); L.sweep(); assert.equal(L.roomCount(), 1);
    const b = connect(L, '2.2.2.2'); assert.equal(b.fire('g-join', { code }).ok, true); b.disconnect();
    L.tick(11 * 60_000); L.sweep(); assert.equal(L.roomCount(), 0);
});

test('лимит комнат и лимит соединений с одного адреса', () => {
    const L = layer({ limits: { maxRooms: 2 } });
    const s = [1, 2, 3].map((i) => connect(L, '9.9.9.' + i));
    assert.equal(s[0].fire('g-create', {}).ok, true);
    assert.equal(s[1].fire('g-create', {}).ok, true);
    assert.equal(s[2].fire('g-create', {}).code, 'full');
    const L2 = layer(), socks = [];
    for (let i = 0; i < 10; i++) socks.push(connect(L2, '5.5.5.5'));
    assert.equal(socks.filter((x) => x.disconnected).length, 2);
});

test('нельзя быть в двух комнатах, выйти и создать новую можно', () => {
    const L = layer(), a = connect(L);
    a.fire('g-create', { role: 'seller' });
    assert.equal(a.fire('g-create', {}).code, 'in-room');
    a.fire('g-leave');
    assert.equal(a.fire('g-create', {}).ok, true);
});

test('действия с числами: данные округляются, мусор отбрасывается', () => {
    const L = layer(), a = connect(L), b = connect(L, '2.2.2.2');
    const { code } = a.fire('g-create', { role: 'seller' }); b.fire('g-join', { code });
    a.fire('g-ev', { t: 'act', a: 'throw', d: [1, 2.3456] });
    assert.deepEqual(b.last('g-ev'), { t: 'act', a: 'throw', d: [1, 2.35] });
    a.fire('g-ev', { t: 'act', a: 'bite', d: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
    assert.equal(b.last('g-ev').d.length, 8);
    const n = b.got.length;
    a.fire('g-ev', { t: 'act', a: 'bite', d: ['x'] });
    a.fire('g-ev', { t: 'act', a: 'bite', d: [1e9] });
    assert.equal(b.got.length, n);
    b.fire('g-ev', { t: 'act', a: 'push' });
    assert.deepEqual(a.last('g-ev'), { t: 'act', a: 'push' });
});

test('снимок мира идёт только от продавца и только числами', () => {
    const L = layer(), a = connect(L), b = connect(L, '2.2.2.2');
    const { code } = a.fire('g-create', { role: 'seller' }); b.fire('g-join', { code });
    a.fire('g-w', { w: [1, 2, 3.14159] });
    assert.deepEqual(b.last('g-w'), { w: [1, 2, 3.14] });
    b.fire('g-w', { w: [9, 9] });
    assert.equal(a.last('g-w'), undefined);
    const n = b.got.length;
    a.fire('g-w', { w: new Array(100).fill(1) });
    a.fire('g-w', { w: ['a'] });
    a.fire('g-w', 'x');
    assert.equal(b.got.length, n);
});

test('частота снимков мира ограничена', () => {
    const L = layer(), a = connect(L), b = connect(L, '2.2.2.2');
    const { code } = a.fire('g-create', { role: 'seller' }); b.fire('g-join', { code });
    for (let i = 0; i < 200; i++) a.fire('g-w', { w: [i] });
    assert.ok(b.got.filter((g) => g[0] === 'g-w').length <= 16);
});
