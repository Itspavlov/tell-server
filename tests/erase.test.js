'use strict';
// Удаление аккаунта (требование магазинов приложений), жалобы на контент и блокировка пользователей
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountStore, nameKey } = require('../src/accounts');
const { ListingStore } = require('../src/listings');
const { RequestStore } = require('../src/requests');
const { Inbox } = require('../src/inbox');
const { FavoriteStore } = require('../src/favorites');
const { ReviewStore } = require('../src/reviews');
const { ServiceStore } = require('../src/services');
const { DvizStore } = require('../src/dviz');
const { SearchStore } = require('../src/searches');
const { InviteStore } = require('../src/invites');
const { PushStore } = require('../src/push');
const { MediaStore } = require('../src/media');
const { DmStore } = require('../src/dm');
const { GroupStore, AdReactions } = require('../src/groups');
const { ReportStore } = require('../src/reports');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { makeCfg, makeStore, makeIo, limiters, silent, PNG } = require('./helpers');

const PW = 'correct horse 9';
const TOKEN = 'c'.repeat(40);
const res = () => { const r = { code: 200, body: null }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.set = () => r; return r; };
const rq = (tok, o = {}) => ({ ip: '6.6.6.6', params: {}, query: {}, headers: tok ? { authorization: 'Bearer ' + tok } : {}, body: {}, ...o });
const AD = () => ({ type: 'rent', title: 'Студия у моря', priceNum: 3000, price: '3 000', location: 'Анапа', description: 'x', photos: [PNG], thumb: PNG });
const SV = () => ({ title: 'Прогулки на джипах', tag: 'tours', text: 'Горы', city: 'Сочи', price: 2500, unit: 'за человека', photos: [PNG] });
const DV = () => ({ title: 'Джипы в горы', text: 'Едем смотреть водопады', place: 'Набережная', when: '2027-06-12T10:00', max: 6, photos: [PNG] });
const REQ = () => ({ category: 'apartment', city: 'Адлер', dateFrom: '2027-03-15', dateTo: '2027-03-20', guests: 2, budget: 3500, text: 'Ищу квартиру' });

async function setup() {
    const cfg = makeCfg();
    const clock = { t: Date.parse('2027-03-10T12:00:00Z') };
    const now = () => clock.t;
    const d = cfg.dataDir, lg = silent;
    const accounts = new AccountStore({ dataDir: d, limits: cfg.limits, logger: lg, now }); await accounts.init();
    const media = new MediaStore({ dataDir: d, logger: lg, now }); await media.init();
    const dms = new DmStore({ dataDir: d, accounts, limits: cfg.limits, media, logger: lg, now }); await dms.init();
    const groups = new GroupStore({ dataDir: d, accounts, limits: cfg.limits, media, logger: lg, now }); await groups.init();
    const adReacts = new AdReactions({ dataDir: d, logger: lg }); await adReacts.init();
    const listings = new ListingStore({ dataDir: d, accounts, limits: { ...cfg.limits, dailyListings: 100 }, now, logger: lg }); await listings.init();
    const requests = new RequestStore({ dataDir: d, limits: cfg.limits, now, logger: lg }); await requests.init();
    const inbox = new Inbox({ dataDir: d, now, logger: lg }); await inbox.init();
    const favorites = new FavoriteStore({ dataDir: d, logger: lg }); await favorites.init();
    const reviews = new ReviewStore({ dataDir: d, accounts, dms, now, logger: lg }); await reviews.init(); listings.reviews = reviews;
    const services = new ServiceStore({ dataDir: d, accounts, now, logger: lg }); await services.init();
    const dviz = new DvizStore({ dataDir: d, accounts, services, now, logger: lg }); await dviz.init();
    const searches = new SearchStore({ dataDir: d, now, logger: lg }); await searches.init();
    const invites = new InviteStore({ dataDir: d, accounts, limits: cfg.limits, now, logger: lg }); await invites.init();
    const pushStore = new PushStore({ dataDir: d, logger: lg, now }); await pushStore.init();
    const reports = new ReportStore({ dataDir: d, now, logger: lg }); await reports.init();
    const store = await makeStore(cfg);
    const io = makeIo(); const kicked = [];
    io.in = (room) => ({ disconnectSockets: () => kicked.push(room) });
    const admin = createAdmin({ token: TOKEN, dataDir: d, logger: lg });
    const h = createHandlers({ cfg, store, admin, accounts, listings, requests, inbox, favorites, reviews, services, dviz, searches, media, dms, invites, groups, adReacts, reports, pushStore, limiters: limiters(cfg), io, logger: lg });
    const reg = async (n, verified) => { const u = await accounts.register(n, PW); if (verified) await accounts.setVerified(nameKey(n), true); return { ...accounts.authenticate(u.token), token: u.token }; };
    return { cfg, clock, accounts, listings, requests, inbox, favorites, reviews, services, dviz, searches, invites, pushStore, media, dms, groups, adReacts, reports, store, io, kicked, h, reg, d };
}

test('удаление аккаунта: пароль обязателен, чужие данные остаются, свои исчезают везде', async () => {
    const s = await setup();
    const A = await s.reg('Анна', true), B = await s.reg('Борис', true);
    const la = (await s.listings.save(A, { ad: AD(), profile: {} })).listing.id;
    const lb = (await s.listings.save(B, { ad: AD(), profile: {} })).listing.id;
    await s.requests.create(A, REQ()); const rb = (await s.requests.create(B, REQ())).request;
    const sa = (await s.services.save(A, SV())).service, sb = (await s.services.save(B, SV())).service;
    const dva = (await s.dviz.create(A, DV())).event, dvb = (await s.dviz.create(B, DV())).event;
    await s.dviz.comment(A, dvb.id, 'Я с вами!'); await s.dviz.toggleJoin(A, dvb.id);
    s.reviews.data.items.rv_a = { id: 'rv_a', listingId: lb, ownerId: B.id, authorId: A.id, authorName: 'Анна', rating: 5, text: 'Отлично', created: 1 };
    s.reviews.data.items.rv_b = { id: 'rv_b', listingId: la, ownerId: A.id, authorId: B.id, authorName: 'Борис', rating: 4, text: 'Хорошо', created: 2 };
    s.reviews._index(); await s.reviews.file.save(s.reviews.data);
    await s.favorites.set(A.id, lb, true, s.listings); await s.favorites.set(B.id, lb, true, s.listings);
    await s.searches.add(A.id, { name: 'Мой', filter: { city: 'Анапа' } });
    s.inbox.add(A.id, { kind: 'dm', title: 'Привет', body: 'x' }); await s.inbox.flush();
    s.pushStore.data.subs[A.id] = [{ endpoint: 'https://push.example.com/1', keys: { p256dh: 'k', auth: 'a' }, created: 1 }];
    await s.invites.ensureCode(A.id);
    const m = await s.media.save(A.id, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(3000, 1)]), 3, 'video');
    const conv = (await s.dms.open(B, 'Анна', {})).conv; assert.ok(conv, 'диалог открылся');
    await s.dms.send(B, conv.id, 'Здравствуйте'); await s.dms.send(A, conv.id, 'Привет');
    const g = (await s.groups.create(A, 'Компания')).group;
    await s.groups.join(B, g.code);
    await s.groups.send(A, g.id, { text: 'сообщение Анны' }); await s.groups.send(B, g.id, { text: 'сообщение Бориса' });
    const solo = (await s.groups.create(A, 'Только я')).group;
    s.store.data.chat = s.store.data.chat || [];
    await s.adReacts.toggle(lb, '👍', A.id);

    // неверный пароль
    let r = res(); await s.h.accountDelete(rq(A.token, { body: { password: 'неверный пароль 1' } }), r);
    assert.equal(r.code, 401); assert.ok(s.accounts.byId(A.id), 'аккаунт на месте');
    // без входа
    r = res(); await s.h.accountDelete(rq(null, { body: { password: PW } }), r); assert.equal(r.code, 401);

    r = res(); await s.h.accountDelete(rq(A.token, { body: { password: PW } }), r);
    assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.ok, true);

    assert.equal(s.accounts.byId(A.id), null); assert.equal(s.accounts.authenticate(A.token), null, 'сессия закрыта');
    assert.equal((await s.accounts.login('Анна', PW)).ok, false, 'войти нельзя');
    assert.ok(s.kicked.includes('user:' + A.id), 'сокеты отключены');
    assert.equal(s.listings.rawById(la), null); assert.ok(s.listings.rawById(lb), 'чужое объявление живо');
    assert.equal(s.requests.list ? Object.values(s.requests.data.requests).filter(x => x.ownerId === A.id).length : 0, 0);
    assert.ok(s.requests.data.requests[rb.id], 'чужой запрос жив');
    assert.equal(s.services.data.items[sa.id], undefined); assert.ok(s.services.data.items[sb.id]);
    assert.equal(s.dviz.data.items[dva.id], undefined);
    const live = s.dviz.data.items[dvb.id]; assert.ok(live);
    assert.equal(live.comments.length, 0, 'комментарии Анны ушли'); assert.equal(live.joins.length, 0, 'её отклик ушёл');
    assert.equal(s.reviews.data.items.rv_a, undefined, 'её отзыв ушёл'); assert.equal(s.reviews.data.items.rv_b, undefined, 'отзыв на её объявление ушёл');
    assert.deepEqual(s.favorites.ids(A.id), []); assert.deepEqual(s.favorites.ids(B.id), [lb], 'избранное Бориса цело');
    assert.deepEqual(s.searches.list(A.id), []);
    assert.equal(s.inbox.data.items[A.id], undefined); assert.equal(s.pushStore.data.subs[A.id], undefined);
    assert.equal(s.invites.data.codes[A.id], undefined);
    assert.equal(s.media.items[m.id], undefined, 'файл удалён');
    assert.equal(s.dms.list(B).length, 0, 'диалог удалён и у собеседника');
    const gb = s.groups.data.groups[g.id];
    assert.deepEqual(gb.members, [B.id]); assert.equal(gb.ownerId, B.id, 'владелец группы — Борис');
    assert.equal(gb.messages.some(x => x.from === A.id), false, 'сообщения Анны из группы удалены'); assert.equal(gb.messages.length, 1);
    assert.equal(s.groups.data.groups[solo.id], undefined, 'пустая группа удалена');
    assert.equal(s.adReacts.view(lb, B.id).counts['👍'], undefined, 'реакции удалены');
    // имя снова свободно, всё сохранилось на диск
    assert.equal((await s.accounts.register('Анна', PW)).ok, true);
    const again = new AccountStore({ dataDir: s.d, limits: s.cfg.limits, logger: silent }); await again.init();
    assert.equal(again.byId(A.id), null);
    await s.store.close();
});

test('удаление аккаунта: при сбое аккаунт остаётся, повтор доводит дело до конца', async () => {
    const s = await setup();
    const A = await s.reg('Анна', true);
    const la = (await s.listings.save(A, { ad: AD(), profile: {} })).listing.id;
    const orig = s.services.file.save; await s.services.save(A, SV());
    s.services.file.save = async () => { throw new Error('диск'); };
    let r = res(); await s.h.accountDelete(rq(A.token, { body: { password: PW } }), r);
    assert.equal(r.code, 503); assert.equal(r.body.code, 'ERASE_FAILED');
    assert.ok(s.accounts.byId(A.id), 'аккаунт не удалён');
    s.services.file.save = orig;
    r = res(); await s.h.accountDelete(rq(A.token, { body: { password: PW } }), r);
    assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(s.listings.rawById(la), null); assert.equal(s.accounts.byId(A.id), null);
    await s.store.close();
});

test('удаление аккаунта: режим поддержки и лимит попыток', async () => {
    const s = await setup();
    const A = await s.reg('Анна');
    for (let i = 0; i < 5; i++) { const r = res(); await s.h.accountDelete(rq(A.token, { body: { password: 'неверный пароль ' + i } }), r); assert.equal(r.code, 401); }
    const r = res(); await s.h.accountDelete(rq(A.token, { body: { password: PW } }), r);
    assert.equal(r.code, 429, 'после пяти попыток — пауза');
    const s2 = await setup(); const B = await s2.reg('Борис');
    const sup = await s2.accounts.startSupport(nameKey('Борис'));
    const res2 = res(); await s2.h.supportGuard(rq(sup.token, { path: '/auth/account' }), res2, () => { throw new Error('не должно пройти'); });
    assert.equal(res2.code, 403);
    await s.store.close(); await s2.store.close();
});

test('жалобы на контент: создать, повтор, своё, пропавшее, админ видит и закрывает', async () => {
    const s = await setup();
    const A = await s.reg('Анна', true), B = await s.reg('Борис', true);
    const lb = (await s.listings.save(B, { ad: AD(), profile: {} })).listing.id;
    const sv = (await s.services.save(B, SV())).service.id;
    const dv = (await s.dviz.create(B, DV())).event.id;
    const rqst = (await s.requests.create(B, REQ())).request.id;
    const send = async (tok, body) => { const r = res(); await s.h.reportCreate(rq(tok, { body }), r); return r; };

    assert.equal((await send(null, { kind: 'listing', targetId: lb, reason: 'spam' })).code, 401);
    let r = await send(A.token, { kind: 'listing', targetId: lb, reason: 'spam', text: 'Реклама' });
    assert.equal(r.code, 201);
    assert.equal((await send(A.token, { kind: 'listing', targetId: lb, reason: 'spam' })).code, 409, 'повтор в тот же день');
    for (const [kind, id] of [['service', sv], ['dviz', dv], ['request', rqst], ['user', B.id]]) assert.equal((await send(A.token, { kind, targetId: id, reason: 'abuse' })).code, 201, kind);
    assert.equal((await send(B.token, { kind: 'listing', targetId: lb, reason: 'spam' })).code, 400, 'на своё нельзя');
    assert.equal((await send(A.token, { kind: 'listing', targetId: 'l_нет', reason: 'spam' })).code, 404);
    assert.equal((await send(A.token, { kind: 'нечто', targetId: lb, reason: 'spam' })).code, 404, 'неизвестный вид — не найден');
    assert.equal((await send(A.token, { kind: 'dviz', targetId: dv, reason: 'пустяк' })).code, 400, 'причина из списка');

    // сообщение в комнате
    s.store.data.chat = s.store.data.chat || [];
    s.store.data.chat.push({ id: 'msg_1', room: 'chat', user: 'Борис', text: 'плохое сообщение', time: Date.now() });
    r = await send(A.token, { kind: 'message', room: 'chat', targetId: 'msg_1', reason: 'abuse' }); assert.equal(r.code, 201, JSON.stringify(r.body));

    // панель модератора
    let a = res(); await s.h.adminContentReports(rq(null), a); assert.equal(a.code, 401);
    a = res(); await s.h.adminContentReports(rq(null, { headers: { authorization: 'Bearer ' + TOKEN } }), a);
    assert.equal(a.code, 200); assert.equal(a.body.reports.length, 6);
    const first = a.body.reports.find(x => x.kind === 'listing');
    assert.equal(first.ownerName, 'Борис'); assert.equal(first.title, 'Студия у моря'); assert.equal(first.reporterName, 'Анна');
    const c = res(); await s.h.adminContentReportClose(rq(null, { headers: { authorization: 'Bearer ' + TOKEN }, params: { id: first.id }, body: { note: 'удалено' } }), c);
    assert.equal(c.code, 200);
    a = res(); await s.h.adminContentReports(rq(null, { headers: { authorization: 'Bearer ' + TOKEN } }), a); assert.equal(a.body.reports.length, 5);
    // после перезапуска жалобы на месте
    const again = new ReportStore({ dataDir: s.d, logger: silent }); await again.init();
    assert.equal(again.list({ status: 'all' }).length, 6);
    await s.store.close();
});

test('блокировка пользователя: общий список, ЛС закрыты, снять можно', async () => {
    const s = await setup();
    const A = await s.reg('Анна'), B = await s.reg('Борис');
    const set = async (tok, body) => { const r = res(); await s.h.blockSet(rq(tok, { body }), r); return r; };
    assert.equal((await set(null, { userId: B.id })).code, 401);
    assert.equal((await set(A.token, { userId: A.id })).code, 400, 'себя нельзя');
    assert.equal((await set(A.token, { userId: 'u_нет' })).code, 404);
    let r = await set(A.token, { userId: B.id }); assert.equal(r.code, 200); assert.deepEqual(r.body.users, [{ id: B.id, name: 'Борис' }]);
    const l = res(); await s.h.blocksList(rq(A.token), l); assert.deepEqual(l.body.users.map(x => x.name), ['Борис']);
    const conv = (await s.dms.open(B, 'Анна', {})).conv;
    assert.equal((await s.dms.send(B, conv.id, 'привет')).ok, false, 'Борису писать Анне нельзя');
    r = await set(A.token, { userId: B.id, on: false }); assert.deepEqual(r.body.users, []);
    assert.equal((await s.dms.send(B, conv.id, 'привет')).ok, true);
    await s.store.close();
});

test('регистрация с согласием: время и версия документов сохраняются', async () => {
    const s = await setup();
    const r = res();
    await s.h.register(rq(null, { body: { name: 'Вера', password: PW, consent: true, consentVersion: '2026-11' } }), r);
    assert.equal(r.code, 201);
    const u = s.accounts.data.users[r.body.user.id];
    assert.equal(u.consent.v, '2026-11'); assert.ok(u.consent.at > 0);
    const r2 = res(); await s.h.register(rq(null, { body: { name: 'Глеб', password: PW } }), r2);
    assert.equal(r2.code, 201); assert.equal(s.accounts.data.users[r2.body.user.id].consent, undefined, 'старые клиенты без согласия не ломаются');
    await s.store.close();
});
