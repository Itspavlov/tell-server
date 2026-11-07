'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountStore, nameKey } = require('../src/accounts');
const { ListingStore } = require('../src/listings');
const { RequestStore } = require('../src/requests');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { makeCfg, makeStore, makeIo, limiters, silent, PNG } = require('./helpers');

const PW = 'correct horse 9';
const DAY = 86400000;
async function setup() {
    const cfg = makeCfg();
    const clock = { t: Date.parse('2027-03-10T12:00:00Z') };
    const now = () => clock.t;
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const listings = new ListingStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, now, logger: silent }); await listings.init();
    const requests = new RequestStore({ dataDir: cfg.dataDir, limits: cfg.limits, now, logger: silent }); await requests.init();
    const store = await makeStore(cfg);
    const io = makeIo();
    const admin = createAdmin({ token: '', dataDir: cfg.dataDir, logger: silent });
    const h = createHandlers({ cfg, store, admin, accounts, listings, requests, limiters: limiters(cfg), io, logger: silent });
    const reg = async (n, verified) => { const u = await accounts.register(n, PW); if (verified) await accounts.setVerified(nameKey(n), true); return { ...accounts.authenticate(u.token), token: u.token }; };
    return { cfg, clock, accounts, listings, requests, store, io, h, reg };
}
const res = () => { const r = { code: 200, body: null }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.set = () => r; return r; };
const req = (o = {}) => ({ ip: '4.4.4.4', params: {}, query: {}, headers: {}, body: {}, ...o });
const AD = (n) => ({ type: 'rent', title: 'Студия ' + n, priceNum: 3000, price: '3 000', location: 'Анапа', description: 'x', photos: [PNG], thumb: PNG });
const REQ = (o = {}) => ({ category: 'apartment', city: 'Адлер', dateFrom: '2027-03-15', dateTo: '2027-03-20', guests: 2, budget: 3500, text: 'Ищу квартиру', ...o });

test('запрос: создаётся, виден всем, чужие не могут менять', async () => {
    const { requests, reg, store } = await setup();
    const a = await reg('Анна'), b = await reg('Борис');
    const r = await requests.create(a, REQ());
    assert.equal(r.ok, true);
    assert.equal(r.request.status, 'active');
    assert.equal(requests.list({ viewerId: b.id }).length, 1);
    assert.equal(requests.list({ viewerId: b.id })[0].mine, false);
    assert.equal((await requests.edit(b, r.request.id, REQ({ city: 'Сочи' }))).code, 'NOT_OWNER');
    assert.equal((await requests.setStatus(b, r.request.id, 'closed')).code, 'NOT_OWNER');
    await store.close();
});

test('запрос: не чаще раза в 60 секунд, таймер считает сервер', async () => {
    const { requests, reg, clock, store } = await setup();
    const a = await reg('Анна');
    assert.equal((await requests.create(a, REQ())).ok, true);
    let r = await requests.create(a, REQ({ city: 'Сочи' }));
    assert.equal(r.code, 'REQUEST_WAIT');
    assert.equal(r.wait, 60);
    clock.t += 43000;
    r = await requests.create(a, REQ({ city: 'Сочи' }));
    assert.equal(r.code, 'REQUEST_WAIT'); assert.equal(r.wait, 17);
    clock.t += 17000;
    assert.equal((await requests.create(a, REQ({ city: 'Сочи' }))).ok, true);
    await store.close();
});

test('запрос: параллельные отправки пропускают только одну', async () => {
    const { requests, reg, store } = await setup();
    const a = await reg('Анна');
    const all = await Promise.all([1, 2, 3, 4, 5].map(i => requests.create(a, REQ({ city: 'Город' + i }))));
    assert.equal(all.filter(r => r.ok).length, 1);
    assert.equal(requests.list({ viewerId: a.id }).length, 1);
    await store.close();
});

test('запрос: дубликат, лимит активных, неверные поля', async () => {
    const { requests, reg, clock, store } = await setup();
    const a = await reg('Анна');
    assert.equal((await requests.create(a, REQ())).ok, true);
    clock.t += 61000;
    assert.equal((await requests.create(a, REQ())).code, 'REQUEST_DUPLICATE');
    for (const bad of [REQ({ dateFrom: '2020-01-01' }), REQ({ dateTo: '2027-03-01' }), REQ({ guests: 99 }), REQ({ budget: -5 }), REQ({ dateFrom: 'завтра' }), { }, null]) {
        assert.equal((await requests.create(a, bad)).code, 'BAD_REQUEST', JSON.stringify(bad));
    }
    for (let i = 0; i < 4; i++) { clock.t += 61000; assert.equal((await requests.create(a, REQ({ city: 'Г' + i }))).ok, true); }
    clock.t += 61000;
    assert.equal((await requests.create(a, REQ({ city: 'Лишний' }))).code, 'TOO_MANY_REQUESTS');
    await store.close();
});

test('запрос: правка без лимита и без подъёма в ленте', async () => {
    const { requests, reg, clock, store } = await setup();
    const a = await reg('Анна');
    const first = (await requests.create(a, REQ({ city: 'Первый' }))).request;
    clock.t += 61000;
    const second = (await requests.create(a, REQ({ city: 'Второй' }))).request;
    assert.deepEqual(requests.list({ viewerId: a.id }).map(r => r.id), [second.id, first.id]);
    clock.t += 1000;
    const e = await requests.edit(a, first.id, REQ({ city: 'Первый', budget: 4000 }));   // сразу, без ожидания
    assert.equal(e.ok, true);
    assert.equal(e.request.budget, 4000);
    assert.deepEqual(requests.list({ viewerId: a.id }).map(r => r.id), [second.id, first.id], 'порядок не изменился');
    assert.equal(requests.cooldown(a.id) > 0, true, 'правка не сбросила и не обошла таймер');
    await store.close();
});

test('запрос: статусы и срок актуальности', async () => {
    const { requests, reg, clock, store } = await setup();
    const a = await reg('Анна');
    const r = (await requests.create(a, REQ())).request;
    assert.equal((await requests.setStatus(a, r.id, 'found')).request.status, 'found');
    assert.equal(requests.list({ viewerId: a.id }).length, 0);
    assert.equal(requests.list({ viewerId: a.id, status: 'found' }).length, 1);
    assert.equal((await requests.edit(a, r.id, REQ())).code, 'BAD_REQUEST', 'завершённый не редактируется');
    clock.t += 61000;
    const r2 = (await requests.create(a, REQ({ city: 'Сочи' }))).request;
    clock.t += 15 * DAY;
    assert.equal(requests.get(r2.id, a.id).status, 'expired');
    assert.equal(requests.list({ viewerId: a.id }).length, 0);
    assert.equal(requests.list({ viewerId: a.id, status: 'expired' }).length, 1);
    await store.close();
});

test('запрос: сохраняется на диск и переживает перезапуск вместе с таймером', async () => {
    const { requests, reg, cfg, clock, store } = await setup();
    const a = await reg('Анна');
    await requests.create(a, REQ());
    const again = new RequestStore({ dataDir: cfg.dataDir, limits: cfg.limits, now: () => clock.t, logger: silent }); await again.init();
    assert.equal(again.list({ viewerId: a.id }).length, 1);
    assert.equal(again.cooldown(a.id), 60);
    await store.close();
});

test('запрос: при сбое записи ничего не остаётся и лимит не тратится', async () => {
    const { cfg, clock, reg, store } = await setup();
    const a = await reg('Анна');
    const bad = { mkdir: async () => {}, readFile: async () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; }, open: async () => { throw new Error('disk'); }, writeFile: async () => {}, rename: async () => {} };
    const rs = new RequestStore({ dataDir: cfg.dataDir + '/x', limits: cfg.limits, now: () => clock.t, logger: silent, fsImpl: bad }); await rs.init();
    assert.equal((await rs.create(a, REQ())).code, 'STORE_UNAVAILABLE');
    assert.equal(rs.list({ viewerId: a.id }).length, 0);
    assert.equal(rs.cooldown(a.id), 0);
    await store.close();
});

test('HTTP запросы: вход обязателен, список открыт, таймер в ответе', async () => {
    const { h, reg, store } = await setup();
    const a = await reg('Анна');
    const hdr = { authorization: 'Bearer ' + a.token };
    let r = res(); await h.requestCreate(req({ body: REQ() }), r); assert.equal(r.code, 401);
    r = res(); await h.requestCreate(req({ headers: hdr, body: REQ() }), r); assert.equal(r.code, 200);
    const id = r.body.request.id;
    assert.ok(r.body.cooldown > 0);
    r = res(); await h.requestCreate(req({ headers: hdr, body: REQ({ city: 'Сочи' }) }), r); assert.equal(r.code, 429); assert.ok(r.body.wait > 0);
    r = res(); h.requestsList(req(), r); assert.equal(r.body.requests.length, 1); assert.equal(r.body.cooldown, 0);
    r = res(); h.requestsList(req({ query: { mine: '1' } }), r); assert.equal(r.code, 401);
    r = res(); h.requestsList(req({ headers: hdr, query: { mine: '1' } }), r); assert.equal(r.body.requests.length, 1); assert.ok(r.body.cooldown > 0);
    r = res(); await h.requestStatus(req({ headers: hdr, params: { id }, body: { status: 'closed' } }), r); assert.equal(r.body.request.status, 'closed');
    r = res(); await h.requestStatus(req({ headers: hdr, params: { id }, body: { status: 'active' } }), r); assert.equal(r.code, 400);
    await store.close();
});

test('объявления: 3 новых в день, правка не тратит, удаление не возвращает', async () => {
    const { h, reg, listings, clock, store } = await setup();
    const u = await reg('Хозяйка', true);
    const hdr = { authorization: 'Bearer ' + u.token };
    const save = async (n, id) => { const r = res(); await h.listingSave(req({ headers: hdr, body: { id, ad: AD(n), profile: {} } }), r); return r; };
    const ids = [];
    for (let i = 1; i <= 3; i++) { const r = await save(i); assert.equal(r.code, 200); assert.equal(r.body.quota.used, i); ids.push(r.body.listing.id); }
    let r = await save(4); assert.equal(r.code, 429); assert.equal(r.body.code, 'DAILY_LIMIT'); assert.equal(r.body.quota.left, 0);
    r = await save('3 правка', ids[2]); assert.equal(r.code, 200, 'правка бесплатна');
    r = res(); await h.listingDelete(req({ headers: hdr, params: { id: ids[0] } }), r); assert.equal(r.code, 200);
    r = await save(5); assert.equal(r.code, 429, 'удаление не возвращает публикацию');
    r = res(); h.listingQuota(req({ headers: hdr }), r); assert.equal(r.body.quota.used, 3);
    clock.t += DAY;                                           // следующие сутки
    r = await save(6); assert.equal(r.code, 200);
    assert.equal(listings.quota(u.id).used, 1);
    await store.close();
});

test('объявления: параллельные публикации не создают четвёртое', async () => {
    const { listings, reg, store } = await setup();
    const u = await reg('Хозяйка', true);
    const all = await Promise.all([1, 2, 3, 4, 5, 6].map(i => listings.save(u, { ad: AD(i), profile: {} })));
    assert.equal(all.filter(r => r.ok).length, 3);
    assert.equal(all.filter(r => r.code === 'DAILY_LIMIT').length, 3);
    assert.equal(listings.list().length, 3);
    await store.close();
});

test('объявления: счётчик по полуночи сервиса (Москва), а не UTC', async () => {
    const { reg, cfg, clock, accounts, store } = await setup();
    const u = await reg('Хозяйка', true);
    const { dayKey } = require('../src/listings');
    assert.equal(dayKey(Date.parse('2027-03-10T20:59:00Z'), 'Europe/Moscow'), '2027-03-10');
    assert.equal(dayKey(Date.parse('2027-03-10T21:01:00Z'), 'Europe/Moscow'), '2027-03-11');
    await store.close();
});

// ---------- подбор и предложения ----------
const { matches } = require('../src/match');
const LAD = (o = {}) => ({ type: 'rent', category: 'apartment', title: 'Студия у моря', priceNum: 3000, price: '3 000', location: 'Адлер, ул. Ленина', description: 'x', photos: [PNG], thumb: PNG, busy: [], form: { guests: '3' }, ...o });
async function withListings(clock) {
    const s = await setup();
    const owner = await s.reg('Хозяйка', true);
    const add = async (o) => { const r = await s.listings.save(owner, { ad: LAD(o), profile: {} }); assert.equal(r.ok, true); return r.listing.id; };
    return { ...s, owner, add };
}

test('подбор: город, цена, гости, категория, занятые даты', () => {
    const l = (o) => ({ ad: LAD(o) });
    const r = (o) => ({ category: 'apartment', city: 'Адлер', dateFrom: '2027-03-15', dateTo: '2027-03-20', guests: 2, budget: 3500, ...o });
    assert.equal(matches(r(), l()), true);
    assert.equal(matches(r({ city: 'Сочи' }), l()), false, 'другой город');
    assert.equal(matches(r({ budget: 2000 }), l()), false, 'дороже бюджета');
    assert.equal(matches(r({ guests: 5 }), l()), false, 'не вмещает гостей');
    assert.equal(matches(r({ category: 'house' }), l()), false, 'другая категория');
    assert.equal(matches(r(), l({ type: 'sale' })), false, 'продажа не подходит');
    assert.equal(matches(r(), l({ busy: ['2027-03-17'] })), false, 'занято в середине');
    assert.equal(matches(r(), l({ busy: ['2027-03-20'] })), true, 'день выезда не считается ночью');
    assert.equal(matches(r(), l({ busy: ['2027-03-15'] })), false, 'занят день заезда');
    assert.equal(matches(r({ category: '' , city: '', guests: null, budget: null, dateFrom: '', dateTo: '' }), l()), true, 'пустые условия — подходит всё аренда');
    assert.equal(matches(r({ guests: 2 }), l({ form: {}, facts: [] })), true, 'вместимость неизвестна — не отсеиваем');
});

test('подбор: автор запроса видит подходящие варианты, чужие — нет', async () => {
    const { requests, listings, reg, add, store } = await withListings();
    const a = await reg('Анна'), b = await reg('Борис');
    const good = await add({ title: 'Подходит' });
    await add({ title: 'Дорого', priceNum: 9000 });
    await add({ title: 'Занято', busy: ['2027-03-16'] });
    const q = (await requests.create(a, REQ({ budget: 3500 }))).request;
    const m = requests.matchesFor(a, q.id, listings);
    assert.deepEqual(m.listings.map(x => x.id), [good]);
    assert.equal(requests.matchesFor(b, q.id, listings).code, 'NOT_OWNER');
    assert.equal(requests.countMatches(requests.data.requests[q.id], listings), 1);
    await store.close();
});

test('подходящие арендаторы: хозяин видит запросы под свои объекты', async () => {
    const { requests, listings, reg, add, owner, store } = await withListings();
    const a = await reg('Анна');
    const lid = await add();
    await requests.create(a, REQ());
    const list = requests.matchingFor(owner, listings);
    assert.equal(list.length, 1);
    assert.equal(list[0].myMatches[0].id, lid);
    assert.equal(list[0].myMatches[0].offered, false);
    assert.equal(requests.matchingFor(a, listings).length, 0, 'у арендатора нет объектов');
    await store.close();
});

test('предложение: проходит проверки, не дублируется, арендатор видит и отклоняет', async () => {
    const { requests, listings, reg, add, owner, clock, store } = await withListings();
    const a = await reg('Анна'), other = await reg('Другой', true);
    const good = await add(), busy = await add({ title: 'Занято', busy: ['2027-03-16'] });
    const q = (await requests.create(a, REQ())).request;
    assert.equal((await requests.offer(owner, q.id, busy, listings)).code, 'OFFER_MISMATCH', 'нельзя предлагать занятое');
    assert.equal((await requests.offer(a, q.id, good, listings)).code, 'BAD_REQUEST', 'свой запрос');
    assert.equal((await requests.offer(other, q.id, good, listings)).code, 'LISTING_NOT_FOUND', 'чужое жильё');
    const r1 = await requests.offer(owner, q.id, good, listings);
    assert.equal(r1.ok, true);
    assert.equal((await requests.offer(owner, q.id, good, listings)).code, 'OFFER_DUPLICATE');
    const par = await Promise.all([1, 2, 3].map(() => requests.offer(owner, q.id, busy, listings)));   // занятое не проходит и параллельно
    assert.equal(par.filter(x => x.ok).length, 0);
    assert.equal(requests.matchingFor(owner, listings)[0].myMatches.find(x => x.id === good).offered, true);
    const mine = requests.offersFor(a, q.id, listings);
    assert.equal(mine.offers.length, 1); assert.equal(mine.offers[0].listing.id, good);
    assert.equal(requests.offersFor(other, q.id, listings).code, 'NOT_OWNER');
    assert.equal(requests.offerCount(q.id), 1);
    assert.equal((await requests.rejectOffer(other, q.id, mine.offers[0].id)).code, 'NOT_OWNER');
    assert.equal((await requests.rejectOffer(a, q.id, mine.offers[0].id)).ok, true);
    assert.equal(requests.offersFor(a, q.id, listings).offers.length, 0);
    assert.equal((await requests.offer(owner, q.id, good, listings)).code, 'OFFER_DUPLICATE', 'отклонённое не пересылается повторно');
    await requests.setStatus(a, q.id, 'found');
    const g2 = await add({ title: 'Ещё' });
    assert.equal((await requests.offer(owner, q.id, g2, listings)).code, 'REQUEST_CLOSED');
    await store.close();
});

test('предложение: параллельные одинаковые отправки дают одно', async () => {
    const { requests, listings, reg, add, owner, store } = await withListings();
    const a = await reg('Анна');
    const good = await add();
    const q = (await requests.create(a, REQ())).request;
    const all = await Promise.all([1, 2, 3, 4].map(() => requests.offer(owner, q.id, good, listings)));
    assert.equal(all.filter(x => x.ok).length, 1);
    await store.close();
});

test('HTTP: найдено вариантов при создании, предложение и уведомление арендатору', async () => {
    const s = await setup();
    const notes = [];
    const notifier = { notify: (ids, p) => notes.push({ ids, p }) };
    const h = createHandlers({ cfg: s.cfg, store: s.store, admin: createAdmin({ token: '', dataDir: s.cfg.dataDir, logger: silent }), accounts: s.accounts, listings: s.listings, requests: s.requests, limiters: limiters(s.cfg), io: s.io, notifier, logger: silent });
    const a = await s.accounts.register('Анна', PW), o = await s.accounts.register('Хозяйка', PW); await s.accounts.setVerified(nameKey('Хозяйка'), true);
    const ho = { authorization: 'Bearer ' + o.token }, ha = { authorization: 'Bearer ' + a.token };
    let r = res(); await h.listingSave(req({ headers: ho, body: { ad: LAD(), profile: {} } }), r); assert.equal(r.code, 200);
    const lid = r.body.listing.id;
    r = res(); await h.requestCreate(req({ headers: ha, body: REQ() }), r); assert.equal(r.body.matches, 1);
    const rid = r.body.request.id;
    r = res(); h.requestsList(req({ headers: ha, query: { mine: '1' } }), r); assert.equal(r.body.requests[0].matchCount, 1); assert.equal(r.body.requests[0].offerCount, 0);
    r = res(); h.requestsMatching(req({ headers: ho }), r); assert.equal(r.body.requests.length, 1);
    r = res(); await h.requestOffer(req({ headers: ho, params: { id: rid }, body: { listingId: lid } }), r); assert.equal(r.code, 200);
    assert.equal(notes.length, 1); assert.equal(notes[0].p.kind, 'offer');
    r = res(); await h.requestOffer(req({ headers: ho, params: { id: rid }, body: { listingId: lid } }), r); assert.equal(r.code, 409);
    r = res(); h.requestOffers(req({ headers: ha, params: { id: rid } }), r); assert.equal(r.body.offers.length, 1);
    r = res(); h.requestOffers(req({ headers: ho, params: { id: rid } }), r); assert.equal(r.code, 403);
    r = res(); h.requestMatches(req({ headers: ha, params: { id: rid } }), r); assert.equal(r.body.listings.length, 1);
    r = res(); h.requestMatches(req({}), r); assert.equal(r.code, 401);
    r = res(); h.requestsList(req({ headers: ha, query: { mine: '1' } }), r); assert.equal(r.body.requests[0].offerCount, 1);
    await s.store.close();
});

// ---------- уведомления о подходящем жилье ----------
test('уведомления: подошло новое жильё — один раз на пару «запрос — объявление»', async () => {
    const { requests, listings, reg, add, owner, store } = await withListings();
    const a = await reg('Анна'), b = await reg('Борис');
    await requests.create(a, REQ());
    const id1 = await add({ title: 'Подходит' });
    let n = await requests.matchesNotify(listings.rawById(id1));
    assert.equal(n.length, 1); assert.equal(n[0].ownerId, a.id);
    assert.deepEqual(await requests.matchesNotify(listings.rawById(id1)), [], 'повтор не уведомляет');
    const id2 = await add({ title: 'Дорого', priceNum: 9000 });
    assert.deepEqual(await requests.matchesNotify(listings.rawById(id2)), [], 'не подходит по цене');
    // правка: цена снизилась, теперь подходит — уведомление уходит
    await listings.save(owner, { id: id2, ad: LAD({ title: 'Дорого', priceNum: 3000 }), profile: {} });
    n = await requests.matchesNotify(listings.rawById(id2));
    assert.equal(n.length, 1);
    await store.close();
});

test('уведомления: выключенные, закрытые и собственные запросы не получают', async () => {
    const { requests, listings, reg, add, owner, clock, store } = await withListings();
    const a = await reg('Анна'), b = await reg('Борис');
    const q1 = (await requests.create(a, REQ())).request;
    clock.t += 61000;
    await requests.create(b, REQ({ city: 'Адлер', text: 'другой' }));
    assert.equal((await requests.setNotify(b, (requests.list({ viewerId: b.id, mine: true })[0]).id, false)).request.notify, false);
    assert.equal((await requests.setNotify(a, requests.list({ viewerId: b.id, mine: true })[0] ? q1.id : q1.id, true)).ok, true);
    assert.equal((await requests.setNotify(b, q1.id, false)).code, 'NOT_OWNER');
    const id = await add();
    const n = await requests.matchesNotify(listings.rawById(id));
    assert.deepEqual(n.map(x => x.ownerId), [a.id], 'только у кого уведомления включены');
    await requests.setStatus(a, q1.id, 'found');
    const id2 = await add({ title: 'Ещё' });
    assert.deepEqual(await requests.matchesNotify(listings.rawById(id2)), [], 'закрытый запрос не уведомляется');
    await store.close();
});

test('уведомления: несколько запросов одного человека — одно уведомление; свой объект не уведомляет', async () => {
    const { requests, listings, reg, add, owner, clock, store } = await withListings();
    const a = await reg('Анна');
    await requests.create(a, REQ()); clock.t += 61000;
    await requests.create(a, REQ({ text: 'второй запрос' }));
    const id = await add();
    const n = await requests.matchesNotify(listings.rawById(id));
    assert.equal(n.length, 1); assert.equal(n[0].count, 2);
    await requests.create(owner, REQ({ text: 'хозяйка сама ищет' }));
    const id2 = await add({ title: 'Другое' });
    assert.ok(!(await requests.matchesNotify(listings.rawById(id2))).some(x => x.ownerId === owner.id));
    await store.close();
});

test('срок запроса: об окончании сообщаем один раз', async () => {
    const { requests, reg, clock, store } = await withListings();
    const a = await reg('Анна');
    await requests.create(a, REQ());
    assert.deepEqual(await requests.expireDue(), []);
    clock.t += 15 * DAY;
    const due = await requests.expireDue();
    assert.equal(due.length, 1); assert.equal(due[0].ownerId, a.id);
    assert.deepEqual(await requests.expireDue(), []);
    await store.close();
});

test('HTTP: публикация объявления уведомляет подходящего арендатора', async () => {
    const s = await setup();
    const notes = [];
    const notifier = { notify: (ids, p) => notes.push({ ids, p }) };
    const h = createHandlers({ cfg: s.cfg, store: s.store, admin: createAdmin({ token: '', dataDir: s.cfg.dataDir, logger: silent }), accounts: s.accounts, listings: s.listings, requests: s.requests, limiters: limiters(s.cfg), io: s.io, notifier, logger: silent });
    const a = await s.accounts.register('Анна', PW), o = await s.accounts.register('Хозяйка', PW); await s.accounts.setVerified(nameKey('Хозяйка'), true);
    let r = res(); await h.requestCreate(req({ headers: { authorization: 'Bearer ' + a.token }, body: REQ() }), r); assert.equal(r.body.matches, 0);
    r = res(); await h.listingSave(req({ headers: { authorization: 'Bearer ' + o.token }, body: { ad: LAD(), profile: {} } }), r); assert.equal(r.code, 200);
    await new Promise(x => setTimeout(x, 30));
    assert.equal(notes.length, 1); assert.equal(notes[0].p.kind, 'match'); assert.deepEqual(notes[0].ids, [a.user.id]);
    r = res(); await h.requestNotify(req({ headers: { authorization: 'Bearer ' + a.token }, params: { id: s.requests.list({ viewerId: a.user.id, mine: true })[0].id }, body: { on: false } }), r); assert.equal(r.body.request.notify, false);
    await s.store.close();
});

test('запрос: владелец удаляет его вместе с предложениями, чужой не может', async () => {
    const { requests, reg, h, io } = await setup();
    const a = await reg('Анна'), b = await reg('Борис');
    const q = (await requests.create(a, REQ())).request;
    assert.equal((await requests.remove(b, q.id)).code, 'NOT_OWNER');
    assert.equal((await requests.remove(a, 'nope')).code, 'REQUEST_NOT_FOUND');
    requests.data.offers.o1 = { id: 'o1', requestId: q.id, ownerId: b.id, listingId: 'l1', status: 'new', created: 1 };
    let r = res(); await h.requestDelete(req({ headers: { authorization: 'Bearer ' + b.token }, params: { id: q.id } }), r);
    assert.equal(r.code, 403);
    r = res(); await h.requestDelete(req({ headers: { authorization: 'Bearer ' + a.token }, params: { id: q.id } }), r);
    assert.equal(r.code, 200); assert.equal(r.body.ok, true);
    assert.equal(requests.list({ viewerId: a.id, status: 'all' }).length, 0);
    assert.equal(Object.keys(requests.data.offers).length, 0);
    r = res(); await h.requestDelete(req({ headers: { authorization: 'Bearer ' + a.token }, params: { id: q.id } }), r);
    assert.equal(r.code, 404);
});

test('карточки других разделов: заголовок обязателен, раздел и вид сохраняются, к жилью не подбираются', async () => {
    const { requests, listings, reg, clock, store } = await setup();
    const a = await reg('Анна'), b = await reg('Борис', true);
    assert.equal((await requests.create(a, { section: 'work', kind: 'seek', city: 'Сочи' })).code, 'BAD_REQUEST');   // нет заголовка
    const r = await requests.create(a, { section: 'work', kind: 'offer', title: 'Нужен официант', city: 'Сочи', budget: 2000, category: 'apartment' });
    assert.equal(r.ok, true);
    assert.equal(r.request.section, 'work'); assert.equal(r.request.kind, 'offer'); assert.equal(r.request.title, 'Нужен официант');
    assert.equal(r.request.category, '');                                   // категория жилья здесь не нужна
    clock.t += 61000;
    const t = await requests.create(a, { section: 'trips', kind: 'seek', title: 'Ищу попутчиков в Адлер', dateFrom: '2027-03-15', guests: 2 });
    assert.equal(t.ok, true);
    clock.t += 61000;
    const h = await requests.create(a, REQ());                              // жильё по умолчанию
    assert.equal(h.request.section, 'housing'); assert.equal(h.request.kind, 'seek');
    assert.equal(requests.list({ viewerId: b.id, section: 'work' }).length, 1);
    assert.equal(requests.list({ viewerId: b.id, section: 'housing' }).length, 1);
    assert.equal(requests.list({ viewerId: b.id, kind: 'offer' }).length, 1);
    assert.equal(requests.list({ viewerId: b.id }).length, 3);
    // у жилья «Предоставляю» — это объявление: запрос такого вида превращается в обычный «Ищу»
    clock.t += 61000;
    assert.equal((await requests.create(a, REQ({ city: 'Сочи', kind: 'offer' }))).request.kind, 'seek');
    // карточка работы не должна «подходить» под объявления
    const lr = await listings.save(b, { ad: AD(1), profile: {} });
    assert.equal(lr.ok, true);
    assert.equal(requests.countMatches(requests.data.requests[r.request.id], listings), 0);
    const hit = await requests.matchesNotify(listings.rawById(lr.listing.id));
    assert.ok(!hit.some(x => x.requests.includes(r.request.id) || x.requests.includes(t.request.id)));
    assert.equal(requests.matchesFor(a, r.request.id, listings).listings.length, 0);
    // правка не меняет раздел и вид
    const e = await requests.edit(a, r.request.id, { section: 'market', kind: 'seek', title: 'Нужен повар', city: 'Сочи' });
    assert.equal(e.ok, true); assert.equal(e.request.section, 'work'); assert.equal(e.request.kind, 'offer'); assert.equal(e.request.title, 'Нужен повар');
    await store.close();
});
