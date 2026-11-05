'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { MediaStore, sniff } = require('../src/media');
const { DmStore } = require('../src/dm');
const { AccountStore } = require('../src/accounts');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { makeCfg, makeStore, makeIo, limiters, silent } = require('./helpers');

const webm = (n = 5000) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(n)]);
const mp4 = (n = 5000) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(n)]);
const PW = 'correct horse 9';
const mk = async (accounts, name) => { const r = await accounts.register(name, PW); return Object.assign({}, accounts.authenticate(r.token), { token: r.token }); };

async function setup() {
    const cfg = makeCfg();
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const media = new MediaStore({ dataDir: cfg.dataDir, logger: silent }); await media.init();
    const dms = new DmStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, media, logger: silent }); await dms.init();
    const store = await makeStore(cfg);
    const admin = createAdmin({ token: '', dataDir: cfg.dataDir, logger: silent });
    const h = createHandlers({ cfg, store, admin, accounts, media, limiters: limiters(cfg), io: makeIo(), logger: silent });
    return { cfg, accounts, media, dms, h, store };
}
const res = () => { const r = { code: 200, body: null, headers: {} }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.set = (k, v) => { r.headers[k] = v; return r; }; return r; };
const req = (o = {}) => ({ ip: '4.4.4.4', params: {}, query: {}, headers: {}, body: {}, ...o });
const auth = (t) => ({ authorization: 'Bearer ' + t });

test('тип видео определяется по содержимому', () => {
    assert.equal(sniff(webm()).ext, 'webm');
    assert.equal(sniff(mp4()).ext, 'mp4');
    assert.equal(sniff(Buffer.from('<script>alert(1)</script>'.repeat(100))), null);
});

test('загрузка: нужен вход, только видео, размер ограничен', async () => {
    const { h, accounts, store } = await setup();
    const u = await mk(accounts, 'Аня');
    let r = res(); await h.mediaUpload(req({ body: webm() }), r); assert.equal(r.code, 401);
    r = res(); await h.mediaUpload(req({ headers: auth(u.token), body: Buffer.from('x'.repeat(5000)) }), r); assert.equal(r.code, 400);
    r = res(); await h.mediaUpload(req({ headers: auth(u.token), body: {} }), r); assert.equal(r.code, 400);
    r = res(); await h.mediaUpload(req({ headers: auth(u.token), body: webm(6_100_000) }), r); assert.equal(r.code, 413);
    r = res(); await h.mediaUpload(req({ headers: auth(u.token), body: webm(), query: { dur: '12' } }), r);
    assert.equal(r.code, 200); assert.match(r.body.id, /^vm_[0-9a-f]{32}$/); assert.equal(r.body.dur, 12);
    await store.close();
});

test('отдача видео: только по точному id, чужие пути не работают', async () => {
    const { h, accounts, media, store } = await setup();
    const u = await mk(accounts, 'Аня');
    const saved = await media.save(u.id, webm(), 5);
    assert.ok(media.get(saved.id));
    assert.equal(media.get('../../etc/passwd'), null);
    assert.equal(media.get('vm_' + 'z'.repeat(32)), null);
    const r = res(); h.mediaGet(req({ params: { id: '../x' } }), r); assert.equal(r.code, 404);
    await store.close();
});

test('личные сообщения: видео прикрепляет только его загрузивший', async () => {
    const { accounts, media, dms, store } = await setup();
    const a = await mk(accounts, 'Аня'), b = await mk(accounts, 'Борис'), c = await mk(accounts, 'Вера');
    const conv = (await dms.open(a, 'Борис')).conv;
    const mine = await media.save(a.id, webm(), 7);
    const theirs = await media.save(c.id, webm(), 7);
    let r = await dms.send(a, conv.id, '', null, { id: theirs.id });
    assert.equal(r.ok, false);
    r = await dms.send(a, conv.id, '', null, { id: 'vm_' + '0'.repeat(32) });
    assert.equal(r.ok, false);
    r = await dms.send(a, conv.id, '', null, { id: mine.id, dur: 999 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.message.video, { id: mine.id, dur: 7 });       // длительность берётся с сервера
    const h = dms.history(b, conv.id);
    assert.equal(h.messages[0].video.id, mine.id);
    assert.equal(dms.list(b)[0].last.text, 'Видеосообщение');
    assert.equal((await dms.send(a, conv.id, '', null)).ok, false);    // пустое без видео по-прежнему нельзя
    await store.close();
});

test('старые видео удаляются', async () => {
    const cfg = makeCfg();
    let t = 1_000_000;
    const media = new MediaStore({ dataDir: cfg.dataDir, now: () => t, logger: silent }); await media.init();
    const s = await media.save('u1', webm(), 3);
    const file = media.get(s.id).path;
    assert.ok(fs.existsSync(file));
    t += 31 * 24 * 3600 * 1000;
    await media.sweep();
    assert.equal(media.get(s.id), null);
    assert.ok(!fs.existsSync(file));
});
