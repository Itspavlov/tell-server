'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { MediaStore, sniff } = require('../src/media');
const { DmStore } = require('../src/dm');
const { AccountStore } = require('../src/accounts');
const { GroupStore } = require('../src/groups');
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

const ogg = (n = 5000) => Buffer.concat([Buffer.from('OggS'), Buffer.alloc(n)]);

test('голосовые: тип audio, лимиты своих размеров, видео и голос не подменяют друг друга', async () => {
    const { accounts, media, dms, store } = await setup();
    const a = await mk(accounts, 'Аня'), b = await mk(accounts, 'Борис');
    const conv = (await dms.open(a, 'Борис')).conv;
    const v = await media.save(a.id, webm(), 8, 'voice');
    assert.equal(media.get(v.id).mime, 'audio/webm');
    assert.equal((await media.save(a.id, ogg(), 8, 'voice')).ok, true);
    assert.equal((await media.save(a.id, ogg(), 8, 'video')).ok, false);                 // ogg — только для голоса
    assert.equal((await media.save(a.id, webm(2_600_000), 8, 'voice')).code, 'TOO_LARGE');
    assert.equal((await media.save(a.id, webm(3_000_000), 8, 'video')).ok, true);
    assert.equal((await media.save(a.id, webm(), 999, 'voice')).dur, 120);
    assert.equal((await dms.send(a, conv.id, '', null, { id: v.id })).ok, false);      // голос нельзя выдать за видео
    const r = await dms.send(a, conv.id, '', null, null, { id: v.id });
    assert.equal(r.ok, true);
    assert.deepEqual(r.message.voice, { id: v.id, dur: 8 });
    assert.equal(dms.list(b)[0].last.text, 'Голосовое сообщение');
    assert.equal((await dms.send(a, conv.id, '', null, { id: v.id }, { id: v.id })).ok, false);
    await store.close();
});

test('группы: видео и голос только свои, видны участникам', async () => {
    const cfg = makeCfg();
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const media = new MediaStore({ dataDir: cfg.dataDir, logger: silent }); await media.init();
    const groups = new GroupStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, media, logger: silent }); await groups.init();
    const a = await mk(accounts, 'Аня'), c = await mk(accounts, 'Вера');
    const g = await groups.create(a, 'Отпуск');
    const gid = g.group.id;
    const mine = await media.save(a.id, webm(), 6, 'voice');
    const theirs = await media.save(c.id, webm(), 6, 'voice');
    assert.equal((await groups.send(a, gid, { voice: { id: theirs.id } })).ok, false);
    assert.equal((await groups.send(a, gid, { video: { id: mine.id } })).ok, false);
    const r = await groups.send(a, gid, { voice: { id: mine.id } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.message.voice, { id: mine.id, dur: 6 });
    assert.equal(groups.list(a)[0].last.text, 'Голосовое сообщение');
    assert.equal((await groups.send(a, gid, {})).ok, false);
});

test('фото: принимаются JPEG/PNG/WebP, чужие форматы и большие файлы отклоняются', async () => {
    const { media } = await setup();
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000)]);
    const png = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(3000)]);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(3000)]);
    for (const b of [jpg, png, webp]) { const r = await media.save('u1', b, 0, 'photo'); assert.equal(r.ok, true); assert.equal(media.check(r.id, 'u1', 'photo').ok, true); assert.equal(media.check(r.id, 'u2', 'photo').ok, false); assert.equal(media.check(r.id, 'u1', 'video').ok, false); }
    assert.equal((await media.save('u1', webm(), 0, 'photo')).code, 'BAD_FORMAT');
    assert.equal((await media.save('u1', jpg, 0, 'video')).code, 'BAD_FORMAT');
    assert.equal((await media.save('u1', Buffer.concat([jpg, Buffer.alloc(2_100_000)]), 0, 'photo')).code, 'TOO_LARGE');
    const ok = await media.save('u1', jpg, 0, 'photo');
    assert.equal(media.get(ok.id).mime, 'image/jpeg');
});

test('фото в личном сообщении: можно с подписью, чужое фото прикрепить нельзя, не вместе с голосом', async () => {
    const { accounts, media, dms } = await setup();
    const a = await mk(accounts, 'Анна'), b = await mk(accounts, 'Борис');
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000)]);
    const ph = await media.save(a.id, jpg, 0, 'photo');
    const o = await dms.open(a, 'Борис', {});
    assert.equal((await dms.send(b, o.conv.id, '', null, null, null, { id: ph.id })).ok, false);
    const vo = await media.save(a.id, webm(), 5, 'voice');
    assert.equal((await dms.send(a, o.conv.id, '', null, null, { id: vo.id }, { id: ph.id })).ok, false);
    const r = await dms.send(a, o.conv.id, 'Вот комната', null, null, null, { id: ph.id });
    assert.equal(r.ok, true); assert.deepEqual(r.message.photo, { id: ph.id }); assert.equal(r.message.text, 'Вот комната');
    const only = await dms.send(a, o.conv.id, '', null, null, null, { id: (await media.save(a.id, jpg, 0, 'photo')).id });
    assert.equal(only.ok, true);
    assert.equal(dms.list(b).find(c => c.id === o.conv.id).last.text, 'Фото');
    assert.equal((await dms.send(a, o.conv.id, '')).ok, false);
});
