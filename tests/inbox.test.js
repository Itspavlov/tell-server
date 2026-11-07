'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Inbox } = require('../src/inbox');
const { createNotifier } = require('../src/notify');
const { AccountStore } = require('../src/accounts');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { makeCfg, makeStore, makeIo, limiters, silent } = require('./helpers');

const mk = async () => {
    const cfg = makeCfg();
    const clock = { t: 1_800_000_000_000 };
    const inbox = new Inbox({ dataDir: cfg.dataDir, now: () => clock.t, logger: silent, saveDelayMs: 5 });
    await inbox.init();
    return { cfg, clock, inbox };
};
const P = (o = {}) => ({ kind: 'dm', title: 'Анна', body: 'привет', open: 'dm:1', tag: 'dm:1', ...o });

test('центр: уведомление хранится, считается непрочитанным, читается', async () => {
    const { inbox } = await mk();
    inbox.add('u1', P());
    inbox.add('u1', P({ kind: 'offer', tag: 'offer-1', title: 'Вам предложили жильё', open: 'profile' }));
    assert.equal(inbox.unread('u1'), 2);
    assert.equal(inbox.unread('u2'), 0, 'у другого пользователя пусто');
    const l = inbox.list('u1');
    assert.equal(l.items.length, 2); assert.equal(l.items[0].kind, 'offer', 'новые сверху');
    inbox.markRead('u1', { ids: [l.items[0].id] });
    assert.equal(inbox.unread('u1'), 1);
    inbox.markRead('u1', { open: 'dm:1' });
    assert.equal(inbox.unread('u1'), 0);
    inbox.add('u1', P({ tag: 'x' })); inbox.add('u1', P({ tag: 'y' }));
    assert.equal(inbox.markRead('u1', { all: true }).unread, 0);
});

test('центр: одинаковые непрочитанные склеиваются со счётчиком', async () => {
    const { inbox, clock } = await mk();
    inbox.add('u1', P({ body: 'раз' })); clock.t += 1000; inbox.add('u1', P({ body: 'два' })); inbox.add('u1', P({ body: 'три' }));
    const l = inbox.list('u1');
    assert.equal(l.items.length, 1); assert.equal(l.items[0].count, 3); assert.equal(l.items[0].body, 'три'); assert.equal(l.unread, 1);
    inbox.markRead('u1', { all: true });
    inbox.add('u1', P({ body: 'после прочтения' }));
    assert.equal(inbox.list('u1').items.length, 2, 'прочитанное не склеивается с новым');
});

test('центр: настройки по типам; системные отключить нельзя', async () => {
    const { inbox } = await mk();
    assert.equal(inbox.setPref('u1', 'messages', false), true);
    assert.equal(inbox.add('u1', P()).skipped, true);
    assert.equal(inbox.add('u1', P({ kind: 'offer', tag: 'o' })).ok, true, 'другие типы работают');
    assert.equal(inbox.add('u1', P({ kind: 'verify', tag: 'v', title: 'Вы проверенный хозяин' })).ok, true, 'системные приходят всегда');
    assert.equal(inbox.setPref('u1', 'system', false), false);
    assert.equal(inbox.setPref('u1', 'нет-такого', false), false);
    assert.deepEqual(inbox.prefs('u1'), { messages: false, offers: true, matches: true, requests: true, reviews: true, searches: true });
    inbox.setPref('u1', 'messages', true);
    assert.equal(inbox.add('u1', P()).ok, true);
});

test('центр: не больше 100 уведомлений на человека', async () => {
    const { inbox } = await mk();
    for (let i = 0; i < 130; i++) inbox.add('u1', P({ tag: 't' + i }));
    assert.equal(inbox.list('u1', 500).items.length, 100);
    assert.equal(inbox.unread('u1'), 100);
});

test('центр: сохраняется на диск и переживает перезапуск', async () => {
    const { cfg, inbox, clock } = await mk();
    inbox.add('u1', P()); inbox.setPref('u1', 'matches', false);
    await inbox.flush();
    const again = new Inbox({ dataDir: cfg.dataDir, now: () => clock.t, logger: silent }); await again.init();
    assert.equal(again.unread('u1'), 1); assert.equal(again.prefs('u1').matches, false);
});

test('notifier: пишет в центр, отдаёт счётчик, уважает настройки', async () => {
    const { inbox } = await mk();
    const io = makeIo();
    const n = createNotifier({ io, inbox, logger: silent });
    n.notify(['u1'], P());
    n.notify(['u1'], P({ kind: 'offer', tag: 'o1' }));
    const sent = io.emitted.filter(e => e.ev === 'notify');
    assert.equal(sent.length, 2); assert.equal(sent[1].payload.unread, 2); assert.ok(sent[1].payload.id);
    inbox.setPref('u1', 'offers', false);
    n.notify(['u1'], P({ kind: 'offer', tag: 'o2' }));
    assert.equal(io.emitted.filter(e => e.ev === 'notify').length, 2, 'отключённый тип не отправляется');
    assert.equal(inbox.unread('u1'), 2);
});

test('HTTP: список только свой, прочитать, настройки, нужен вход', async () => {
    const { cfg, inbox } = await mk();
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const store = await makeStore(cfg);
    const h = createHandlers({ cfg, store, admin: createAdmin({ token: '', dataDir: cfg.dataDir, logger: silent }), accounts, inbox, limiters: limiters(cfg), io: makeIo(), logger: silent });
    const a = await accounts.register('Анна', 'correct horse 9'), b = await accounts.register('Борис', 'correct horse 9');
    const res = () => { const r = { code: 200, body: null }; r.status = c => { r.code = c; return r; }; r.json = x => { r.body = x; return r; }; r.set = () => r; return r; };
    const rq = (tok, body) => ({ ip: '5.5.5.5', params: {}, query: {}, headers: tok ? { authorization: 'Bearer ' + tok } : {}, body: body || {} });
    inbox.add(a.user.id, P());
    let r = res(); h.inboxList(rq(null), r); assert.equal(r.code, 401);
    r = res(); h.inboxList(rq(a.token), r); assert.equal(r.body.unread, 1); assert.equal(r.body.items.length, 1);
    r = res(); h.inboxList(rq(b.token), r); assert.equal(r.body.unread, 0);
    r = res(); h.inboxRead(rq(b.token, { all: true }), r); assert.equal(inbox.unread(a.user.id), 1, 'чужие не читаются');
    r = res(); h.inboxRead(rq(a.token, { open: 'dm:1' }), r); assert.equal(r.body.unread, 0);
    r = res(); h.inboxPrefs(rq(a.token, { group: 'messages', on: false }), r); assert.equal(r.body.prefs.messages, false);
    r = res(); h.inboxPrefs(rq(a.token, { group: 'system', on: false }), r); assert.equal(r.code, 400);
    await store.close();
});
