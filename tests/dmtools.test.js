'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountStore } = require('../src/accounts');
const { DmStore } = require('../src/dm');
const { GroupStore, AdReactions } = require('../src/groups');
const { createSocketLayer } = require('../src/sockets');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { makeCfg, makeStore, makeIo, makeSocket, limiters, silent } = require('./helpers');

const PW = 'correct horse 9';
async function setup() {
    const cfg = makeCfg();
    const clock = { t: 1_800_000_000_000 };
    const now = () => clock.t;
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const dms = new DmStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, now, logger: silent }); await dms.init();
    const groups = new GroupStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger: silent }); await groups.init();
    const adReacts = new AdReactions({ dataDir: cfg.dataDir, logger: silent }); await adReacts.init();
    const store = await makeStore(cfg);
    const io = makeIo();
    const lim = limiters(cfg);
    const layer = createSocketLayer({ io, cfg, store, accounts, dms, groups, adReacts, limiters: lim, logger: silent });
    const connect = (token) => { const s = makeSocket({}); s.handshake.auth = token ? { token } : {}; layer.onConnection(s); return s; };
    const user = async (name) => { const r = await accounts.register(name, PW); return { token: r.token, id: r.user.id, sock: connect(r.token) }; };
    return { cfg, clock, accounts, dms, store, io, user, lim };
}
const call = (s, ev, data) => new Promise(r => (data === undefined ? s.fire(ev, r) : s.fire(ev, data, r)));
async function pair(env) {
    const a = await env.user('Аня'), b = await env.user('Борис');
    const c = await call(a.sock, 'dm-open', { ownerName: 'Борис', adId: '2', adTitle: 'Студия' });
    return { a, b, convId: c.conv.id };
}

test('прочитано: счётчик непрочитанных, отметка и событие собеседнику', async () => {
    const env = await setup(); const { a, b, convId } = await pair(env);
    await call(a.sock, 'dm-send', { convId, text: 'Привет' });
    await call(a.sock, 'dm-send', { convId, text: 'Свободно?' });
    let list = await call(b.sock, 'dm-list');
    assert.equal(list.convs[0].unread, 2);
    assert.equal((await call(a.sock, 'dm-list')).convs[0].unread, 0);
    env.clock.t += 5000;
    const r = await call(b.sock, 'dm-read', { convId });
    assert.equal(r.ok, true);
    list = await call(b.sock, 'dm-list');
    assert.equal(list.convs[0].unread, 0);
    const ev = env.io.emitted.filter(e => e.ev === 'dm-read');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].room, 'user:' + a.id);
    assert.equal(ev[0].payload.convId, convId);
    // автор видит, когда прочитано
    const hist = await call(a.sock, 'dm-history', { convId });
    assert.equal(hist.conv.peerRead, ev[0].payload.time);
    assert.ok(hist.conv.peerRead > hist.messages[1].time);
    // повторная отметка без новых сообщений ничего не меняет
    await call(b.sock, 'dm-read', { convId });
    assert.equal(env.io.emitted.filter(e => e.ev === 'dm-read').length, 1);
    // чужой не может отмечать
    const c = await env.user('Вера');
    assert.equal((await call(c.sock, 'dm-read', { convId })).code, 'NO_CONVERSATION');
    assert.equal((await call(c.sock, 'dm-read', 'x')).code, 'BAD_PAYLOAD');
    await env.store.close();
});

test('блокировка: обе стороны не могут писать, разблокировка возвращает', async () => {
    const env = await setup(); const { a, b, convId } = await pair(env);
    assert.equal((await call(a.sock, 'dm-send', { convId, text: 'Привет' })).ok, true);
    // Борис блокирует Аню
    const bl = await call(b.sock, 'dm-block', { convId, on: true });
    assert.deepEqual([bl.ok, bl.blockedByMe], [true, true]);
    assert.equal((await call(b.sock, 'dm-list')).convs[0].blockedByMe, true);
    assert.equal((await call(a.sock, 'dm-list')).convs[0].blockedByMe, false);
    // Аня получает нейтральный отказ и не узнаёт «вас заблокировали»
    const r1 = await call(a.sock, 'dm-send', { convId, text: 'Алло' });
    assert.equal(r1.code, 'DM_BLOCKED');
    // Борис тоже не может писать, пока не разблокирует
    assert.equal((await call(b.sock, 'dm-send', { convId, text: 'Ответ' })).code, 'BLOCKED_BY_ME');
    const sent = env.io.emitted.filter(e => e.ev === 'dm-message').length;
    assert.equal(sent, 2);       // только первое сообщение (по одному на участника)
    await call(b.sock, 'dm-block', { convId, on: false });
    assert.equal((await call(a.sock, 'dm-send', { convId, text: 'Снова я' })).ok, true);
    assert.equal((await call(b.sock, 'dm-send', { convId, text: 'Привет' })).ok, true);
    // идемпотентно, и посторонний не может блокировать
    assert.equal((await call(b.sock, 'dm-block', { convId, on: false })).ok, true);
    const c = await env.user('Вера');
    assert.equal((await call(c.sock, 'dm-block', { convId, on: true })).code, 'NO_CONVERSATION');
    await env.store.close();
});

test('блокировка сохраняется после перезапуска', async () => {
    const env = await setup(); const { b, convId } = await pair(env);
    await call(b.sock, 'dm-block', { convId, on: true });
    const dms2 = new DmStore({ dataDir: env.cfg.dataDir, accounts: env.accounts, limits: env.cfg.limits, logger: silent }); await dms2.init();
    assert.deepEqual(Object.values(dms2.data.blocks)[0].length, 1);
    await env.store.close();
});

test('жалоба: причина обязательна, дубль за сутки запрещён, модератор видит и закрывает', async () => {
    const env = await setup(); const { a, b, convId } = await pair(env);
    await call(a.sock, 'dm-send', { convId, text: 'Переведи предоплату на карту' });
    await call(b.sock, 'dm-send', { convId, text: 'Не буду' });
    assert.equal((await call(b.sock, 'dm-report', { convId, reason: 'xxx' })).code, 'BAD_REASON');
    assert.equal((await call(b.sock, 'dm-report', { convId, reason: 'scam', text: 'Просит предоплату' })).ok, true);
    assert.equal((await call(b.sock, 'dm-report', { convId, reason: 'scam' })).code, 'REPORT_DUPLICATE');
    const c = await env.user('Вера');
    assert.equal((await call(c.sock, 'dm-report', { convId, reason: 'spam' })).code, 'NO_CONVERSATION');
    // через сутки можно снова
    env.clock.t += 86400000 + 1;
    assert.equal((await call(b.sock, 'dm-report', { convId, reason: 'abuse' })).ok, true);

    const admin = createAdmin({ token: 'T'.repeat(32), dataDir: env.cfg.dataDir, logger: silent });
    const h = createHandlers({ cfg: env.cfg, store: env.store, admin, accounts: env.accounts, dms: env.dms, limiters: env.lim, io: env.io, logger: silent });
    const res = () => { const r = { code: 200, body: null }; r.status = x => { r.code = x; return r; }; r.json = x => { r.body = x; return r; }; r.set = () => r; return r; };
    const rq = (o = {}) => ({ ip: '9.9.9.9', params: {}, query: {}, headers: {}, body: {}, ...o });
    let r = res(); await h.adminReports(rq(), r); assert.equal(r.code, 401);
    const hdr = { authorization: 'Bearer ' + 'T'.repeat(32) };
    r = res(); await h.adminReports(rq({ headers: hdr }), r);
    assert.equal(r.body.reports.length, 2);
    const rep = r.body.reports.find(x => x.reason === 'scam');
    assert.equal(rep.reporter, 'Борис'); assert.equal(rep.target, 'Аня');
    assert.equal(rep.messages.length, 2); assert.equal(rep.messages[0].from, 'other');
    r = res(); await h.adminReportClose(rq({ headers: hdr, params: { id: rep.id } }), r); assert.equal(r.body.ok, true);
    r = res(); await h.adminReports(rq({ headers: hdr }), r); assert.equal(r.body.reports.length, 1);
    r = res(); await h.adminReportClose(rq({ headers: hdr, params: { id: 'rp_nope' } }), r); assert.equal(r.code, 404);
    await env.store.close();
});
