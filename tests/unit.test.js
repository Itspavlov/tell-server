'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { loadConfig, isOriginAllowed } = require('../src/config');
const v = require('../src/validate');
const { RateLimiter } = require('../src/rateLimit');
const { getClientIp } = require('../src/net');
const { createAdmin } = require('../src/admin');
const { PNG, PNG_B64, tmpDir, silent } = require('./helpers');

const LIM = loadConfig({ NODE_ENV: 'production' }).limits;
const ROOMS = ['housing', 'work', 'market', 'trips'];

test('config: токен короче 32 символов отклоняется', () => {
    assert.throws(() => loadConfig({ ADMIN_TOKEN: 'short' }), /32/);
    assert.doesNotThrow(() => loadConfig({ ADMIN_TOKEN: 'x'.repeat(32) }));
});
test('config: в production нет dev-origin и нет запросов без Origin', () => {
    const c = loadConfig({ NODE_ENV: 'production' });
    assert.equal(isOriginAllowed('http://localhost:3000', c), false);
    assert.equal(isOriginAllowed(undefined, c), false);
    assert.equal(isOriginAllowed('https://gokurort-new.onrender.com/', c), true);
    assert.equal(isOriginAllowed('https://evil.example', c), false);
});
test('config: вне production localhost разрешён', () => {
    const c = loadConfig({});
    assert.equal(isOriginAllowed('http://localhost:5500', c), true);
});
test('config: некорректное число отклоняется', () => {
    assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
});

test('имя: допустимые и недопустимые', () => {
    assert.equal(v.normalizeName('  Тарас  ', LIM).value, 'Тарас');
    assert.equal(v.normalizeName('A', LIM).code, 'INVALID_NAME');
    assert.equal(v.normalizeName('x'.repeat(25), LIM).code, 'INVALID_NAME');
    assert.equal(v.normalizeName('<script>', LIM).code, 'INVALID_NAME');
    assert.equal(v.normalizeName(123, LIM).code, 'INVALID_NAME');
    assert.equal(v.normalizeName({}, LIM).code, 'INVALID_NAME');
});
test('имя: зарезервированные, включая обходы пробелами и символами', () => {
    for (const n of ['Admin', 'a d m i n', 'Админ', 'Moderator', 'Поддержка Tell', 'sys.tem']) {
        assert.equal(v.normalizeName(n, LIM).code, 'RESERVED_NAME', n);
    }
});
test('имя: символы нулевой ширины вычищаются', () => {
    assert.equal(v.normalizeName('Та​рас', LIM).value, 'Тарас');
});

test('текст: лимит длины, чистка управляющих символов', () => {
    assert.equal(v.normalizeText('a'.repeat(1001), 1000).code, 'TEXT_TOO_LONG');
    assert.equal(v.normalizeText('a'.repeat(1000), 1000).ok, true);
    assert.equal(v.normalizeText('he\u0000llo‮', 1000).value, 'hello');
    assert.equal(v.normalizeText('a\n\n\n\n\nb', 1000).value, 'a\n\nb');
    assert.equal(v.normalizeText(5, 1000).code, 'BAD_PAYLOAD');
});

test('картинка: настоящий PNG принимается', () => {
    const r = v.validateImage(PNG, 1_500_000);
    assert.equal(r.ok, true);
    assert.equal(r.mime, 'png');
});
test('картинка: svg/html/javascript отклоняются', () => {
    const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64');
    assert.equal(v.validateImage(svg, 1e6).code, 'IMAGE_INVALID');
    assert.equal(v.validateImage('javascript:alert(1)', 1e6).code, 'IMAGE_INVALID');
    assert.equal(v.validateImage('https://evil.example/x.png', 1e6).code, 'IMAGE_INVALID');
    assert.equal(v.validateImage('data:text/html;base64,PGh0bWw+', 1e6).code, 'IMAGE_INVALID');
    assert.equal(v.validateImage('data:image/png;base64,AAAA"onerror="x', 1e6).code, 'IMAGE_INVALID');
});
test('картинка: заявлен png, а внутри html — отклоняется', () => {
    const fake = 'data:image/png;base64,' + Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    assert.equal(v.validateImage(fake, 1e6).code, 'IMAGE_TYPE_MISMATCH');
});
test('картинка: слишком большая отклоняется', () => {
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(2_000_000)]);
    assert.equal(v.validateImage('data:image/png;base64,' + big.toString('base64'), 1_500_000).code, 'IMAGE_TOO_LARGE');
});
test('картинка: jpeg/gif/webp по сигнатуре', () => {
    const jpg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0]);
    assert.equal(v.validateImage('data:image/jpeg;base64,' + jpg.toString('base64'), 1e6).ok, true);
    const gif = Buffer.from('GIF89a\0\0\0\0');
    assert.equal(v.validateImage('data:image/gif;base64,' + gif.toString('base64'), 1e6).ok, true);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
    assert.equal(v.validateImage('data:image/webp;base64,' + webp.toString('base64'), 1e6).ok, true);
});

test('send: полная проверка и очистка', () => {
    const ok = v.validateSend({ room: 'housing', user: 'Тарас', text: ' привет ', avatar: '<img src=x onerror=1>', clientId: 'abcdef123456' }, LIM, ROOMS);
    assert.equal(ok.ok, true);
    assert.equal(ok.value.text, 'привет');
    assert.equal('avatar' in ok.value, false, 'присланный avatar игнорируется');
});
test('send: плохие данные', () => {
    const f = (d) => v.validateSend(d, LIM, ROOMS).code;
    assert.equal(f(null), 'BAD_PAYLOAD');
    assert.equal(f([]), 'BAD_PAYLOAD');
    assert.equal(f('str'), 'BAD_PAYLOAD');
    assert.equal(f({ room: 'dm_1', user: 'Тарас', text: 'x' }), 'INVALID_ROOM');
    assert.equal(f({ room: '__proto__', user: 'Тарас', text: 'x' }), 'INVALID_ROOM');
    assert.equal(f({ room: 'housing', user: 'Тарас' }), 'EMPTY_MESSAGE');
    assert.equal(f({ room: 'housing', user: 'Тарас', text: '   ' }), 'EMPTY_MESSAGE');
    assert.equal(f({ room: 'housing', user: 'Тарас', text: 'x', clientId: 'a b' }), 'BAD_PAYLOAD');
    assert.equal(f({ room: 'housing', user: 'Тарас', text: { a: 1 } }), 'BAD_PAYLOAD');
});
test('send: только картинка допустима', () => {
    const r = v.validateSend({ room: 'market', user: 'Тарас', image: PNG }, LIM, ROOMS);
    assert.equal(r.ok, true);
    assert.equal(r.value.text, '');
});
test('аватар строится из имени', () => {
    assert.equal(v.avatarFor('тарас'), 'Т');
    assert.equal(v.avatarFor('<b>'), '?');
});

test('rateLimit: окно, блокировка и освобождение', () => {
    let t = 1000;
    const rl = new RateLimiter({ windowMs: 1000, max: 3, now: () => t });
    assert.ok(rl.hit('a').ok && rl.hit('a').ok && rl.hit('a').ok);
    const blocked = rl.hit('a');
    assert.equal(blocked.ok, false);
    assert.ok(blocked.retryAfterMs > 0);
    assert.ok(rl.hit('b').ok, 'другой ключ независим');
    t += 1001;
    assert.ok(rl.hit('a').ok);
    rl.sweep();
});

test('IP: берётся последний адрес из X-Forwarded-For (подделка слева не работает)', () => {
    const h = { address: '10.0.0.1', headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.5' } };
    assert.equal(getClientIp(h, true), '203.0.113.5');
    assert.equal(getClientIp(h, false), '10.0.0.1');
    assert.equal(getClientIp({ address: '9.9.9.9', headers: {} }, true), '9.9.9.9');
});

test('admin: без токена отключён', () => {
    const a = createAdmin({ token: '', dataDir: tmpDir(), logger: silent });
    assert.equal(a.isEnabled(), false);
    assert.equal(a.authorize('Bearer anything'), false);
});
test('admin: проверка Bearer', () => {
    const token = crypto.randomBytes(32).toString('hex');
    const a = createAdmin({ token, dataDir: tmpDir(), logger: silent });
    assert.equal(a.authorize('Bearer ' + token), true);
    assert.equal(a.authorize('Bearer ' + token + 'x'), false);
    assert.equal(a.authorize('Bearer wrong'), false);
    assert.equal(a.authorize(token), false);
    assert.equal(a.authorize(undefined), false);
    assert.equal(a.authorize('Bearer ' + 'a'.repeat(1000)), false);
});
test('admin: журнал пишется и не содержит токен', async () => {
    const dir = tmpDir();
    const token = crypto.randomBytes(32).toString('hex');
    const a = createAdmin({ token, dataDir: dir, logger: silent });
    await a.audit('clear_room', { room: 'work', ip: '1.2.3.4' });
    const log = require('fs').readFileSync(a.auditFile, 'utf-8');
    assert.match(log, /clear_room/);
    assert.equal(log.includes(token), false);
});
