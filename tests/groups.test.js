'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { AccountStore, nameKey } = require('../src/accounts');
const { DmStore } = require('../src/dm');
const { GroupStore, AdReactions } = require('../src/groups');
const { createSocketLayer } = require('../src/sockets');
const { makeCfg, makeStore, makeIo, makeSocket, limiters, silent } = require('./helpers');

const PW = 'correct horse 9';
async function setup() {
    const cfg = makeCfg();
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const dms = new DmStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger: silent }); await dms.init();
    const groups = new GroupStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger: silent }); await groups.init();
    const adReacts = new AdReactions({ dataDir: cfg.dataDir, logger: silent }); await adReacts.init();
    const store = await makeStore(cfg);
    const io = makeIo();
    const lim = limiters(cfg);
    let n = 0;
    const layer = createSocketLayer({ io, cfg, store, accounts, dms, groups, adReacts, limiters: lim, logger: silent, newId: () => 'msg_' + (++n) });
    const connect = (token) => { const s = makeSocket({}); s.handshake.auth = token ? { token } : {}; layer.onConnection(s); return s; };
    const user = async (name) => { const r = await accounts.register(name, PW); return { token: r.token, id: r.user.id, sock: connect(r.token) }; };
    return { cfg, accounts, groups, adReacts, store, io, connect, user };
}
const call = (s, ev, data) => new Promise(r => (data === undefined ? s.fire(ev, r) : s.fire(ev, data, r)));
const AD = { id: '2', title: 'Сдам студию у моря', price: '3 500 ₽/сутки', location: 'Анапа' };

test('группа: создание, название проверяется, список', async () => {
    const { user, store } = await setup();
    const a = await user('Аня');
    assert.equal((await call(a.sock, 'group-create', { name: 'x' })).code, 'BAD_GROUP_NAME');
    const r = await call(a.sock, 'group-create', { name: 'Отпуск 2027' });
    assert.equal(r.ok, true);
    assert.equal(r.group.isOwner, true);
    assert.equal(r.group.members.length, 1);
    assert.equal((await call(a.sock, 'group-list')).groups[0].name, 'Отпуск 2027');
    await store.close();
});

test('группа: без входа нельзя', async () => {
    const { connect, store } = await setup();
    const g = connect();
    assert.equal((await call(g, 'group-create', { name: 'Тест группа' })).code, 'AUTH_REQUIRED');
    assert.equal((await call(g, 'group-list')).code, 'AUTH_REQUIRED');
    await store.close();
});

test('приглашение по имени: участник появляется, получает уведомление; чужого имени нет', async () => {
    const { user, io, store } = await setup();
    const a = await user('Аня'), b = await user('Борис');
    const { group } = await call(a.sock, 'group-create', { name: 'Море' });
    assert.equal((await call(a.sock, 'group-invite', { groupId: group.id, name: 'Нет такого' })).code, 'USER_NOT_FOUND');
    const inv = await call(a.sock, 'group-invite', { groupId: group.id, name: 'борис' });
    assert.equal(inv.ok, true);
    assert.ok(io.emitted.some(e => e.ev === 'group-invited' && e.room === 'user:' + b.id));
    assert.equal((await call(a.sock, 'group-invite', { groupId: group.id, name: 'Борис' })).code, 'ALREADY_MEMBER');
    assert.equal((await call(b.sock, 'group-list')).groups.length, 1);
    await store.close();
});

test('приглашение по коду-ссылке', async () => {
    const { user, store } = await setup();
    const a = await user('Аня'), b = await user('Вера');
    const { group } = await call(a.sock, 'group-create', { name: 'Горы' });
    assert.equal((await call(b.sock, 'group-join', { code: 'неверный' })).code, 'BAD_INVITE');
    const j = await call(b.sock, 'group-join', { code: group.code });
    assert.equal(j.ok, true);
    assert.equal((await call(b.sock, 'group-open', { groupId: group.id })).group.members.length, 2);
    await store.close();
});

test('сообщения группы: только участники читают и пишут, рассылка участникам', async () => {
    const { user, io, store } = await setup();
    const a = await user('Аня'), b = await user('Борис'), x = await user('Чужой');
    const { group } = await call(a.sock, 'group-create', { name: 'Компания' });
    await call(a.sock, 'group-invite', { groupId: group.id, name: 'Борис' });
    const r = await call(a.sock, 'group-send', { groupId: group.id, text: 'Всем привет', clientId: 'grp-client-001' });
    assert.equal(r.ok, true);
    const rooms = io.emitted.filter(e => e.ev === 'group-message').map(e => e.room).sort();
    assert.deepEqual(rooms, ['user:' + a.id, 'user:' + b.id].sort());
    assert.equal((await call(x.sock, 'group-open', { groupId: group.id })).code, 'NO_GROUP');
    assert.equal((await call(x.sock, 'group-send', { groupId: group.id, text: 'я тут' })).code, 'NO_GROUP');
    assert.equal((await call(x.sock, 'group-react', { groupId: group.id, id: r.id, emoji: '🔥' })).code, 'NO_GROUP');
    const dup = await call(a.sock, 'group-send', { groupId: group.id, text: 'Всем привет', clientId: 'grp-client-001' });
    assert.equal(dup.duplicate, true);
    assert.equal(io.emitted.filter(e => e.ev === 'group-message').length, 2);
    await store.close();
});

test('карточка объявления в группе очищается, плохие данные отклоняются', async () => {
    const { user, store } = await setup();
    const a = await user('Аня');
    const { group } = await call(a.sock, 'group-create', { name: 'Выбор жилья' });
    const r = await call(a.sock, 'group-send', { groupId: group.id, ad: { ...AD, title: 'Студия\u0000<b>', evil: 'x' } });
    assert.equal(r.ok, true);
    const h = await call(a.sock, 'group-open', { groupId: group.id });
    assert.equal(h.messages[0].ad.id, '2');
    assert.equal('evil' in h.messages[0].ad, false);
    assert.equal((await call(a.sock, 'group-send', { groupId: group.id, ad: { id: '../x', title: 'q' } })).code, 'BAD_PAYLOAD');
    assert.equal((await call(a.sock, 'group-send', { groupId: group.id })).code, 'EMPTY_MESSAGE');
    await store.close();
});

test('реакции и ответы в группе', async () => {
    const { user, store } = await setup();
    const a = await user('Аня'), b = await user('Борис');
    const { group } = await call(a.sock, 'group-create', { name: 'Планы' });
    await call(a.sock, 'group-invite', { groupId: group.id, name: 'Борис' });
    const first = await call(a.sock, 'group-send', { groupId: group.id, ad: AD });
    let r = await call(b.sock, 'group-react', { groupId: group.id, id: first.id, emoji: '❤️' });
    assert.deepEqual(r.reactions, { '❤️': 1 }); assert.deepEqual(r.mine, ['❤️']);
    r = await call(a.sock, 'group-react', { groupId: group.id, id: first.id, emoji: '❤️' });
    assert.deepEqual(r.reactions, { '❤️': 2 });
    r = await call(b.sock, 'group-react', { groupId: group.id, id: first.id, emoji: '❤️' });
    assert.deepEqual(r.reactions, { '❤️': 1 });
    assert.equal((await call(b.sock, 'group-react', { groupId: group.id, id: first.id, emoji: '💩' })).code, 'BAD_REACTION');
    await call(b.sock, 'group-send', { groupId: group.id, text: 'Беру эту!', replyTo: first.id });
    const h = await call(a.sock, 'group-open', { groupId: group.id });
    assert.equal(h.messages[1].reply.text, '🏠 Сдам студию у моря');
    assert.equal(h.messages[1].reply.user, 'Аня');
    assert.deepEqual(h.messages[0].mine, ['❤️']);
    await store.close();
});

test('выход из группы: владелец передаётся, пустая группа удаляется', async () => {
    const { user, groups, store } = await setup();
    const a = await user('Аня'), b = await user('Борис');
    const { group } = await call(a.sock, 'group-create', { name: 'Тест' });
    await call(a.sock, 'group-invite', { groupId: group.id, name: 'Борис' });
    assert.equal((await call(a.sock, 'group-leave', { groupId: group.id })).ok, true);
    assert.equal((await call(a.sock, 'group-open', { groupId: group.id })).code, 'NO_GROUP');
    assert.equal((await call(b.sock, 'group-open', { groupId: group.id })).group.isOwner, true);
    await call(b.sock, 'group-leave', { groupId: group.id });
    assert.equal(Object.keys(groups.data.groups).length, 0);
    await store.close();
});

test('лимиты: максимум 20 участников, группы переживают перезапуск', async () => {
    const { user, accounts, cfg, store } = await setup();
    const a = await user('Аня');
    const { group } = await call(a.sock, 'group-create', { name: 'Большая' });
    for (let i = 0; i < 19; i++) { await accounts.register('Друг' + String.fromCharCode(1040 + i), PW); await call(a.sock, 'group-invite', { groupId: group.id, name: 'Друг' + String.fromCharCode(1040 + i) }); }
    await accounts.register('Лишний', PW);
    assert.equal((await call(a.sock, 'group-invite', { groupId: group.id, name: 'Лишний' })).code, 'GROUP_FULL');
    await call(a.sock, 'group-send', { groupId: group.id, text: 'сохрани' });
    const g2 = new GroupStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger: silent }); await g2.init();
    assert.equal(g2.open(accounts.findByKey(nameKey('Аня')), group.id).messages[0].text, 'сохрани');
    await store.close();
});

test('повреждённый groups.json не затирается', async () => {
    const cfg = makeCfg();
    const f = path.join(cfg.dataDir, 'groups.json');
    fs.writeFileSync(f, '{"groups": ');
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const g = new GroupStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger: silent });
    await assert.rejects(() => g.init(), (e) => e.code === 'CORRUPT');
    assert.equal(fs.readFileSync(f, 'utf-8'), '{"groups": ');
});

test('реакции на объявления: гость и аккаунт, счётчики, снятие, рассылка', async () => {
    const { user, connect, io, store } = await setup();
    const a = await user('Аня');
    const g = connect();
    let r = await call(a.sock, 'ad-react', { adId: '2', emoji: '❤️' });
    assert.deepEqual(r.reactions, { '❤️': 1 });
    r = await call(g, 'ad-react', { adId: '2', emoji: '❤️', user: 'Гость Иван' });
    assert.deepEqual(r.reactions, { '❤️': 2 });
    assert.ok(io.emitted.some(e => e.ev === 'ad-reaction-update' && e.room === 'housing'));
    const many = await call(a.sock, 'ad-reactions', { ids: ['2', '3'] });
    assert.deepEqual(many.ads['2'].mine, ['❤️']);
    assert.deepEqual(many.ads['3'].counts, {});
    r = await call(a.sock, 'ad-react', { adId: '2', emoji: '❤️' });
    assert.deepEqual(r.reactions, { '❤️': 1 });
    assert.equal((await call(a.sock, 'ad-react', { adId: '../x', emoji: '🔥' })).code, 'BAD_PAYLOAD');
    assert.equal((await call(a.sock, 'ad-react', { adId: '2', emoji: 'x' })).code, 'BAD_REACTION');
    assert.equal((await call(g, 'ad-react', { adId: '2', emoji: '🔥', user: 'Аня' })).code, 'NAME_TAKEN');
    await store.close();
});

test('ответ на объявление в общем чате: цитата строится сервером', async () => {
    const { connect, io, store } = await setup();
    const g = connect(); await call(g, 'join-room', 'housing');
    await call(g, 'send-message', { room: 'housing', user: 'Иван', text: 'сколько?', replyAd: { id: '2', title: 'Сдам студию у моря' }, clientId: 'adreply-0001' });
    const m = io.emitted.find(e => e.ev === 'new-message').payload;
    assert.deepEqual(m.reply, { id: 'ad_2', user: 'Объявление', text: 'Сдам студию у моря' });
    await store.close();
});

test('запрос в личной группе: клиент шлёт только id, данные берутся из активного запроса', async () => {
    const { RequestStore } = require('../src/requests');
    const { cfg, accounts, groups, user, store } = await setup();
    const requests = new RequestStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await requests.init();
    groups.requests = requests;
    const a = await user('Аня'), b = await user('Боря');
    const acc = accounts.authenticate(a.token);
    const cr = await requests.create(acc, { category: 'guest', city: 'Архипо-Осиповка', dateFrom: '2027-06-15', dateTo: '2027-06-25', guests: 4, budget: 4500, text: 'Ищем гостевой дом у моря' });
    assert.equal(cr.ok, true, JSON.stringify(cr));
    const g = (await call(a.sock, 'group-create', { name: 'Хозяева' })).group;
    // приглашаем Борю
    assert.equal((await call(a.sock, 'group-invite', { groupId: g.id, name: 'Боря' })).ok, true);
    const rid = cr.request.id;
    // подделанные поля игнорируются: берётся то, что в самом запросе
    const r = await call(b.sock, 'group-send', { groupId: g.id, clientId: 'c_0123456789abcdef', req: { id: rid, city: 'Подделка', text: 'чужой текст', ownerName: 'Взлом' } });
    assert.equal(r.ok, true, JSON.stringify(r));
    const open = await call(a.sock, 'group-open', { groupId: g.id });
    const m = open.messages.find(x => x.req);
    assert.equal(m.req.id, rid);
    assert.equal(m.req.city, 'Архипо-Осиповка');
    assert.equal(m.req.ownerName, 'Аня');
    assert.equal(m.req.text, 'Ищем гостевой дом у моря');
    assert.equal(m.req.category, 'guest');
    assert.equal('ownerId' in m.req, false);
    // несуществующий запрос и неверный id
    assert.equal((await call(b.sock, 'group-send', { groupId: g.id, req: { id: 'rq_nope' } })).code, 'BAD_PAYLOAD');
    assert.equal((await call(b.sock, 'group-send', { groupId: g.id, req: { id: '../x' } })).code, 'BAD_PAYLOAD');
    // и вместе с объявлением нельзя
    assert.equal((await call(b.sock, 'group-send', { groupId: g.id, req: { id: rid }, ad: AD })).code, 'BAD_PAYLOAD');
    // закрытый запрос в группу не отправить
    await requests.setStatus(acc, rid, 'closed');
    assert.equal((await call(b.sock, 'group-send', { groupId: g.id, req: { id: rid } })).code, 'BAD_PAYLOAD');
    assert.match(open.group && (await call(a.sock, 'group-list')).groups[0].last.text, /Запрос/);
    await store.close();
});
