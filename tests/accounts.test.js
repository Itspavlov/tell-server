'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { AccountStore, nameKey } = require('../src/accounts');
const { DmStore } = require('../src/dm');
const { createSocketLayer } = require('../src/sockets');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { makeCfg, makeStore, makeIo, makeSocket, limiters, silent } = require('./helpers');

async function setup(now = Date.now) {
    const cfg = makeCfg();
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent, now });
    await accounts.init();
    const dms = new DmStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger: silent, now });
    await dms.init();
    const store = await makeStore(cfg);
    const io = makeIo();
    const lim = limiters(cfg);
    let n = 0;
    const layer = createSocketLayer({ io, cfg, store, accounts, dms, limiters: lim, logger: silent, newId: () => 'msg_' + (++n) });
    const connect = (token) => { const s = makeSocket({}); s.handshake.auth = token ? { token } : {}; layer.onConnection(s); return s; };
    return { cfg, accounts, dms, store, io, lim, connect };
}
const call = (s, ev, data) => new Promise(r => (data === undefined ? s.fire(ev, r) : s.fire(ev, data, r)));
const PW = 'correct horse 9';

test('регистрация: пароль хранится хешем, имя уникально без учёта регистра и точек', async () => {
    const { accounts, cfg } = await setup();
    const r = await accounts.register('Тарас', PW);
    assert.equal(r.ok, true);
    assert.equal(r.token.length, 64);
    const file = fs.readFileSync(path.join(cfg.dataDir, 'accounts.json'), 'utf-8');
    assert.equal(file.includes(PW), false, 'пароль не хранится открытым текстом');
    assert.equal(file.includes(r.token), false, 'токен не хранится открытым текстом');
    for (const dup of ['тарас', 'Т.арас', 'ТАРАС ']) assert.equal((await accounts.register(dup, PW)).code, 'NAME_TAKEN', dup);
});

test('регистрация: плохие имя и пароль', async () => {
    const { accounts } = await setup();
    assert.equal((await accounts.register('Admin', PW)).code, 'RESERVED_NAME');
    assert.equal((await accounts.register('Аня', 'short')).code, 'BAD_PASSWORD');
    assert.equal((await accounts.register('Аня', 'x'.repeat(73))).code, 'BAD_PASSWORD');
    assert.equal((await accounts.register('Аня', 12345678)).code, 'BAD_PASSWORD');
});

test('параллельная регистрация одного имени: проходит только одна', async () => {
    const { accounts } = await setup();
    const rs = await Promise.all([accounts.register('Олег', PW), accounts.register('олег', PW)]);
    assert.equal(rs.filter(r => r.ok).length, 1);
});

test('вход: верный пароль, неверный пароль и неизвестное имя дают одинаковую ошибку', async () => {
    const { accounts } = await setup();
    await accounts.register('Мария', PW);
    assert.equal((await accounts.login('мария', PW)).ok, true);
    assert.equal((await accounts.login('Мария', 'wrong password')).code, 'BAD_CREDENTIALS');
    assert.equal((await accounts.login('Нет такого', PW)).code, 'BAD_CREDENTIALS');
});

test('сессия: проверяется токен, просроченный и поддельный не работают, logout закрывает', async () => {
    let t = 1_000_000;
    const { accounts } = await setup(() => t);
    const { token } = await accounts.register('Игорь', PW);
    assert.equal(accounts.authenticate(token).name, 'Игорь');
    assert.equal(accounts.authenticate('0'.repeat(64)), null);
    assert.equal(accounts.authenticate('zzz'), null);
    await accounts.logout(token);
    assert.equal(accounts.authenticate(token), null);
    const t2 = (await accounts.login('Игорь', PW)).token;
    t += 31 * 24 * 3600 * 1000;
    assert.equal(accounts.authenticate(t2), null, 'через 31 день сессия истекла');
});

test('аккаунты переживают перезапуск', async () => {
    const { accounts, cfg } = await setup();
    await accounts.register('Лена', PW);
    const again = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent });
    await again.init();
    assert.equal((await again.login('Лена', PW)).ok, true);
});

test('повреждённый accounts.json не затирается', async () => {
    const cfg = makeCfg();
    const f = path.join(cfg.dataDir, 'accounts.json');
    fs.writeFileSync(f, '{"users": ');
    const a = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent });
    await assert.rejects(() => a.init(), (e) => e.code === 'CORRUPT');
    assert.equal(fs.readFileSync(f, 'utf-8'), '{"users": ');
});

test('HTTP: регистрация/вход/me/logout и лимиты', async () => {
    const { cfg, accounts, store, lim, io } = await setup();
    const admin = createAdmin({ token: '', dataDir: cfg.dataDir, logger: silent });
    const h = createHandlers({ cfg, store, admin, accounts, limiters: lim, io, logger: silent });
    const res = () => { const r = { code: 200, body: null }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.set = () => r; return r; };
    const req = (body, headers = {}) => ({ ip: '3.3.3.3', body, headers, params: {}, query: {} });
    let r = res(); await h.register(req({ name: 'Павел', password: PW }), r);
    assert.equal(r.code, 201);
    const token = r.body.token;
    r = res(); await h.register(req({ name: 'павел', password: PW }), r);
    assert.equal(r.code, 409);
    r = res(); h.me(req({}, { authorization: 'Bearer ' + token }), r);
    assert.equal(r.body.user.name, 'Павел');
    r = res(); h.me(req({}, { authorization: 'Bearer ' + '1'.repeat(64) }), r);
    assert.equal(r.code, 401);
    r = res(); await h.login(req({ name: 'Павел', password: 'nope-nope-nope' }), r);
    assert.equal(r.code, 401);
    r = res(); await h.logout(req({}, { authorization: 'Bearer ' + token }), r);
    r = res(); h.me(req({}, { authorization: 'Bearer ' + token }), r);
    assert.equal(r.code, 401);
    // перебор пароля: 10 в минуту
    const codes = [];
    for (let i = 0; i < 14; i++) { r = res(); await h.login(req({ name: 'Павел', password: 'bad-pass-' + i }), r); codes.push(r.code); }
    assert.ok(codes.includes(429));
    await store.close();
});

test('общий чат: вошедший пишет под именем аккаунта, подмена имени игнорируется', async () => {
    const { accounts, connect, io, store } = await setup();
    const { token } = await accounts.register('Софья', PW);
    const s = connect(token);
    assert.equal(s.sent('server-hello')[0].user.name, 'Софья');
    await call(s, 'join-room', 'housing');
    const r = await call(s, 'send-message', { room: 'housing', user: 'Кто-то другой', text: 'привет', clientId: 'abcdef123456' });
    assert.equal(r.ok, true);
    assert.equal(io.emitted.find(e => e.ev === 'new-message').payload.user, 'Софья');
    await store.close();
});

test('общий чат: гость не может писать и реагировать под занятым именем', async () => {
    const { accounts, connect, store } = await setup();
    await accounts.register('Виктор', PW);
    const g = connect();
    await call(g, 'join-room', 'housing');
    const r = await call(g, 'send-message', { room: 'housing', user: 'виктор', text: 'я Виктор', clientId: 'abcdef123457' });
    assert.equal(r.code, 'NAME_TAKEN');
    assert.equal(store.stats().rooms.housing, 0);
    await store.close();
});

test('ответ на сообщение: цитата берётся с сервера, а не от клиента', async () => {
    const { connect, io, store } = await setup();
    const a = connect(); await call(a, 'join-room', 'housing');
    const first = await call(a, 'send-message', { room: 'housing', user: 'Анна', text: 'Сдаю квартиру', clientId: 'abcdef000001' });
    await call(a, 'send-message', { room: 'housing', user: 'Борис', text: 'Сколько?', replyTo: first.id, clientId: 'abcdef000002' });
    const m = io.emitted.filter(e => e.ev === 'new-message')[1].payload;
    assert.deepEqual(m.reply, { id: first.id, user: 'Анна', text: 'Сдаю квартиру' });
    await call(a, 'send-message', { room: 'housing', user: 'Борис', text: 'Левая цитата', replyTo: 'msg_нет_такого', clientId: 'abcdef000003' });
    assert.equal(io.emitted.filter(e => e.ev === 'new-message')[2].payload.reply, null);
    await store.close();
});

test('реакции: поставить, снять, разные пользователи, недопустимый эмодзи', async () => {
    const { accounts, connect, io, store } = await setup();
    const t1 = (await accounts.register('Один', PW)).token, t2 = (await accounts.register('Двое', PW)).token;
    const a = connect(t1), b = connect(t2);
    await call(a, 'join-room', 'housing'); await call(b, 'join-room', 'housing');
    const sent = await call(a, 'send-message', { room: 'housing', user: 'x', text: 'смотрите', clientId: 'abcdef000010' });
    let r = await call(a, 'react', { room: 'housing', id: sent.id, emoji: '❤️' });
    assert.deepEqual(r.reactions, { '❤️': 1 }); assert.deepEqual(r.mine, ['❤️']);
    r = await call(b, 'react', { room: 'housing', id: sent.id, emoji: '❤️' });
    assert.deepEqual(r.reactions, { '❤️': 2 });
    r = await call(a, 'react', { room: 'housing', id: sent.id, emoji: '❤️' });
    assert.deepEqual(r.reactions, { '❤️': 1 }); assert.deepEqual(r.mine, []);
    assert.equal((await call(a, 'react', { room: 'housing', id: sent.id, emoji: '💩' })).ok, false);
    assert.equal((await call(a, 'react', { room: 'housing', id: 'msg_nope', emoji: '👍' })).code, 'MESSAGE_NOT_FOUND');
    assert.ok(io.emitted.some(e => e.ev === 'reaction-update' && e.payload.id === sent.id));
    // история отдаёт реакции и «мои»
    const c = connect(t2); await call(c, 'join-room', 'housing');
    const hist = c.sent('room-history')[0].find(m => m.id === sent.id);
    assert.deepEqual(hist.reactions, { '❤️': 1 }); assert.deepEqual(hist.mine, ['❤️']);
    await store.close();
});

test('реакции переживают перезапуск', async () => {
    const { accounts, connect, store, cfg } = await setup();
    const t = (await accounts.register('Реакт', PW)).token;
    const a = connect(t); await call(a, 'join-room', 'trips');
    const sent = await call(a, 'send-message', { room: 'trips', user: 'x', text: 'едем', clientId: 'abcdef000020' });
    await call(a, 'react', { room: 'trips', id: sent.id, emoji: '🔥' });
    await store.close();
    const s2 = await makeStore(cfg);
    assert.deepEqual(s2.getHistory('trips').messages[0].reactions, { '🔥': 1 });
    await s2.close();
});

test('личные сообщения: без входа нельзя', async () => {
    const { connect, store } = await setup();
    const g = connect();
    assert.equal((await call(g, 'dm-open', { ownerName: 'Хозяин' })).code, 'AUTH_REQUIRED');
    assert.equal((await call(g, 'dm-list')).code, 'AUTH_REQUIRED');
    assert.equal((await call(g, 'dm-send', { convId: 'dm_x', text: 'привет' })).code, 'AUTH_REQUIRED');
    await store.close();
});

test('личные сообщения: гость пишет хозяину, хозяин видит и отвечает, рассылка только им', async () => {
    const { accounts, connect, io, store } = await setup();
    const tg = (await accounts.register('Гость', PW)).token;
    const to = (await accounts.register('Елена', PW)).token;
    const g = connect(tg), o = connect(to);
    const opened = await call(g, 'dm-open', { ownerName: 'Елена', adId: 'h-1', adTitle: 'Квартира у моря' });
    assert.equal(opened.ok, true);
    const convId = opened.conv.id;
    const sent = await call(g, 'dm-send', { convId, text: 'Здравствуйте! Свободно?', clientId: 'dmclient0001' });
    assert.equal(sent.ok, true);
    const rooms = io.emitted.filter(e => e.ev === 'dm-message').map(e => e.room).sort();
    assert.deepEqual(rooms, ['user:' + accounts.findByKey(nameKey('Гость')).id, 'user:' + accounts.findByKey(nameKey('Елена')).id].sort());
    // повтор не создаёт дубль
    const again = await call(g, 'dm-send', { convId, text: 'Здравствуйте! Свободно?', clientId: 'dmclient0001' });
    assert.equal(again.duplicate, true);
    assert.equal(io.emitted.filter(e => e.ev === 'dm-message').length, 2);
    // хозяин видит диалог с именем гостя
    const list = await call(o, 'dm-list');
    assert.equal(list.convs.length, 1);
    assert.equal(list.convs[0].with, 'Гость');
    assert.equal(list.convs[0].adTitle, 'Квартира у моря');
    const reply = await call(o, 'dm-send', { convId, text: 'Да, свободно' });
    assert.equal(reply.ok, true);
    const h = await call(g, 'dm-history', { convId });
    assert.deepEqual(h.messages.map(m => m.text), ['Здравствуйте! Свободно?', 'Да, свободно']);
    assert.equal(h.messages[1].from.name, 'Елена');
    await store.close();
});

test('личные сообщения: посторонний не читает и не пишет в чужой диалог', async () => {
    const { accounts, connect, store } = await setup();
    const tg = (await accounts.register('Гость', PW)).token;
    await accounts.register('Елена', PW);
    const te = (await accounts.register('Шпион', PW)).token;
    const g = connect(tg), spy = connect(te);
    const { conv } = await call(g, 'dm-open', { ownerName: 'Елена', adTitle: 'x' });
    await call(g, 'dm-send', { convId: conv.id, text: 'секрет' });
    assert.equal((await call(spy, 'dm-history', { convId: conv.id })).code, 'NO_CONVERSATION');
    assert.equal((await call(spy, 'dm-send', { convId: conv.id, text: 'я тут' })).code, 'NO_CONVERSATION');
    assert.deepEqual((await call(spy, 'dm-list')).convs, []);
    await store.close();
});

test('личные сообщения: нельзя писать самому себе; диалог один на пару; валидация', async () => {
    const { accounts, connect, store } = await setup();
    const t = (await accounts.register('Хозяйка', PW)).token;
    const t2 = (await accounts.register('Клиент', PW)).token;
    const o = connect(t), c = connect(t2);
    assert.equal((await call(o, 'dm-open', { ownerName: 'хозяйка' })).code, 'SELF_DM');
    const a = await call(c, 'dm-open', { ownerName: 'Хозяйка', adTitle: 'A' });
    const b = await call(c, 'dm-open', { ownerName: 'ХОЗЯЙКА', adTitle: 'B' });
    assert.equal(a.conv.id, b.conv.id);
    assert.equal((await call(c, 'dm-send', { convId: a.conv.id, text: '   ' })).code, 'EMPTY_MESSAGE');
    assert.equal((await call(c, 'dm-send', { convId: a.conv.id, text: 'x'.repeat(1001) })).code, 'TEXT_TOO_LONG');
    assert.equal((await call(c, 'dm-open', { ownerName: '<b>' })).code, 'INVALID_NAME');
    await store.close();
});

test('личные сообщения: диалог и сообщения переживают перезапуск', async () => {
    const { accounts, connect, store, cfg } = await setup();
    const t = (await accounts.register('Гость', PW)).token;
    await accounts.register('Елена', PW);
    const g = connect(t);
    const { conv } = await call(g, 'dm-open', { ownerName: 'Елена' });
    await call(g, 'dm-send', { convId: conv.id, text: 'сохрани' });
    const a2 = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await a2.init();
    const d2 = new DmStore({ dataDir: cfg.dataDir, accounts: a2, limits: cfg.limits, logger: silent }); await d2.init();
    const user = a2.findByKey(nameKey('Гость'));
    assert.equal(d2.history(user, conv.id).messages[0].text, 'сохрани');
    await store.close();
});

test('dm-delete: удаляет только у себя, собеседник сохраняет переписку, новое сообщение возвращает диалог', async () => {
    const { accounts, connect } = await setup();
    const a = await accounts.register('Анна', PW), b = await accounts.register('Борис', PW);
    const sa = connect(a.token), sb = connect(b.token);
    const o = await call(sa, 'dm-open', { ownerName: 'Борис' });
    assert.equal(o.ok, true, JSON.stringify(o));
    const convId = o.conv.id;
    const s1 = await call(sa, 'dm-send', { convId, text: 'привет' });
    assert.equal(s1.ok, true, JSON.stringify(s1));
    assert.equal((await call(sa, 'dm-list')).convs.length, 1);
    const del = await call(sa, 'dm-delete', { convId });
    assert.equal(del.ok, true);
    assert.equal((await call(sa, 'dm-list')).convs.length, 0, 'у Анны диалога нет');
    assert.equal((await call(sb, 'dm-list')).convs.length, 1, 'у Бориса остался');
    assert.equal((await call(sa, 'dm-delete', { convId: 'nope' })).ok, false);
    await new Promise(r => setTimeout(r, 5));
    const s2 = await call(sb, 'dm-send', { convId, text: 'ответ' });
    assert.equal(s2.ok, true, JSON.stringify(s2));
    const list = (await call(sa, 'dm-list')).convs;
    assert.equal(list.length, 1, 'после нового сообщения диалог вернулся');
    const h = await call(sa, 'dm-history', { convId });
    assert.deepEqual(h.messages.map(m => m.text), ['ответ'], 'старое не вернулось');
});

test('dm-delete: без входа нельзя', async () => {
    const { connect } = await setup();
    const g = connect(null);
    assert.equal((await call(g, 'dm-delete', { convId: 'x' })).ok, false);
});

test('смена имени: вход по новому имени, занятое имя и частые смены отклоняются', async () => {
    let t = 1_700_000_000_000;
    const { accounts } = await setup(() => t);
    const a = await accounts.register('Анна', PW), b = await accounts.register('Борис', PW);
    assert.equal((await accounts.rename(a.user.id, 'борис')).code, 'NAME_TAKEN');
    assert.equal((await accounts.rename(a.user.id, 'x')).ok, false);
    const r = await accounts.rename(a.user.id, 'Алиса');
    assert.equal(r.ok, true); assert.equal(r.user.name, 'Алиса'); assert.equal(r.oldKey, nameKey('Анна'));
    assert.equal((await accounts.login('Алиса', PW)).ok, true);
    assert.equal((await accounts.login('Анна', PW)).ok, false);
    assert.equal(accounts.isNameTaken(nameKey('Анна')), false);
    assert.equal((await accounts.rename(a.user.id, 'Алла')).code, 'RENAME_WAIT');       // раз в сутки
    t += 25 * 3600 * 1000;
    assert.equal((await accounts.rename(a.user.id, 'Алла')).ok, true);
    assert.equal((await accounts.rename(a.user.id, 'Алла')).changed, false);              // то же имя — ничего не делаем
    assert.equal(accounts.byId(b.user.id).name, 'Борис');
});

test('смена имени хозяина переносит диалоги и обновляет подписи в данных', async () => {
    const { accounts, dms, store } = await setup();
    const owner = await accounts.register('Хозяин', PW), guest = await accounts.register('Гостья', PW);
    const g = accounts.byId(guest.user.id);
    const opened = await dms.open(g, 'Хозяин', { id: 'l_1', title: 'Дом' });
    assert.equal(opened.ok, true);
    const r = await accounts.rename(owner.user.id, 'Иван');
    assert.equal(r.ok, true);
    assert.equal(await dms.renameOwner(r.oldKey, nameKey('Иван'), 'Иван'), 1);
    const list = dms.list(g);
    assert.equal((list.convs || list)[0].with, 'Иван');
    const again = await dms.open(g, 'Иван', { id: 'l_1', title: 'Дом' });
    assert.equal(again.ok, true);
    assert.equal(again.conv ? again.conv.id : again.id, opened.conv ? opened.conv.id : opened.id);   // тот же диалог, не новый
    await store.close?.();
});

test('аватарка: только из готового набора; видна в карточках запросов вместе со статусом «в сети»', async () => {
    const { accounts } = await setup();
    const a = await accounts.register('Аня', PW);
    const id = a.user.id;
    assert.equal(accounts.avatarOf(id), '');
    for (const bad of ['av00', 'av36', 'av1', '../x', 'data:image/png;base64,AAAA', 7]) assert.equal((await accounts.setAvatar(id, bad)).code, 'BAD_AVATAR', String(bad));
    assert.deepEqual(await accounts.setAvatar(id, 'av07'), { ok: true, avatar: 'av07' });
    assert.equal(accounts.avatarOf(id), 'av07');
    assert.deepEqual(await accounts.setAvatar(id, ''), { ok: true, avatar: '' });
    assert.equal(accounts.avatarOf(id), '');
    assert.equal((await accounts.setAvatar('u_nope', 'av01')).code, 'AUTH_REQUIRED');
});

test('«был в сети»: обновляется не чаще раза в минуту, режим поддержки его не двигает, на диск пишется пачкой', async () => {
    let t = 1_800_000_000_000;
    const { accounts, cfg } = await setup(() => t);
    const a = await accounts.register('Аня', PW);
    const id = a.user.id;
    const token = a.token;
    accounts.authenticate(token);
    assert.equal(accounts.lastSeenOf(id), t);
    t += 30_000; accounts.authenticate(token);
    assert.equal(accounts.lastSeenOf(id), t - 30_000, 'в пределах минуты не двигается');
    t += 40_000; accounts.authenticate(token);
    assert.equal(accounts.lastSeenOf(id), t);
    t += 5_000; accounts.touch(id, true);
    assert.equal(accounts.lastSeenOf(id), t, 'при отключении — сразу');
    const sup = await accounts.startSupport(nameKey('Аня'));
    t += 120_000; accounts.authenticate(sup.token);
    assert.equal(accounts.lastSeenOf(id), t - 120_000, 'поддержка не отмечается');
    await accounts.flushSeen();
    const again = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await again.init();
    assert.equal(again.lastSeenOf(id), t - 120_000);
});
