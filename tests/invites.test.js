'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountStore, nameKey } = require('../src/accounts');
const { ListingStore } = require('../src/listings');
const { RequestStore } = require('../src/requests');
const { ServiceStore } = require('../src/services');
const { InviteStore } = require('../src/invites');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { makeCfg, makeStore, makeIo, limiters, silent, PNG } = require('./helpers');

const PW = 'correct horse 9';
const DAY = 86400000;
let ipN = 0;

async function setup() {
    const cfg = makeCfg();
    const clock = { t: Date.parse('2027-03-10T12:00:00Z') };
    const now = () => clock.t;
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    // как на сервере: внутренний счётчик объявлений не мешает, считает InviteStore
    const listings = new ListingStore({ dataDir: cfg.dataDir, accounts, limits: { ...cfg.limits, dailyListings: 100 }, now, logger: silent }); await listings.init();
    const requests = new RequestStore({ dataDir: cfg.dataDir, limits: cfg.limits, now, logger: silent }); await requests.init();
    const services = new ServiceStore({ dataDir: cfg.dataDir, accounts, logger: silent }); await services.init();
    const invites = new InviteStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, now, logger: silent }); await invites.init();
    const store = await makeStore(cfg);
    const io = makeIo();
    const sent = [];
    const notifier = { notify: (ids, p) => sent.push({ ids, p }) };
    const admin = createAdmin({ token: '', dataDir: cfg.dataDir, logger: silent });
    const h = createHandlers({ cfg, store, admin, accounts, listings, requests, services, invites, limiters: limiters(cfg), io, notifier, logger: silent });
    const reg = async (n, verified = true, ref) => {
        const r = res(); await h.register(req({ ip: '7.7.7.' + (++ipN), body: { name: n, password: PW, ref } }), r);
        assert.equal(r.code, 201, n);
        if (verified) await accounts.setVerified(nameKey(n), true);
        return { id: r.body.user.id, token: r.body.token, hdr: { authorization: 'Bearer ' + r.body.token } };
    };
    return { cfg, clock, accounts, listings, requests, services, invites, store, h, reg, sent };
}
const res = () => { const r = { code: 200, body: null }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.set = () => r; return r; };
const req = (o = {}) => ({ ip: '4.4.4.4', params: {}, query: {}, headers: {}, body: {}, ...o });
const AD = (n) => ({ type: 'rent', title: 'Студия ' + n, priceNum: 3000, price: '3 000', location: 'Анапа', description: 'x', photos: [PNG], thumb: PNG });
const REQ = (o = {}) => ({ category: 'apartment', city: 'Адлер', dateFrom: '2027-03-15', dateTo: '2027-03-20', guests: 2, budget: 3500, text: 'Ищу квартиру', ...o });
const SVC = (n) => ({ title: 'Прогулка ' + n, category: 'sea', price: 1500, unit: 'person', city: 'Архипо-Осиповка', description: 'Катер', photos: [PNG] });

async function saveAd(h, u, n, id) { const r = res(); await h.listingSave(req({ headers: u.hdr, ip: '5.5.5.' + (++ipN), body: { id, ad: AD(n), profile: {} } }), r); return r; }
async function postReq(h, u, o) { const r = res(); await h.requestCreate(req({ headers: u.hdr, ip: '6.6.6.' + (++ipN), body: REQ(o) }), r); return r; }

test('приглашения: код один на человека, ссылка не привязывается к себе и повторно', async () => {
    const { reg, invites, store } = await setup();
    const a = await reg('Анна'), b = await reg('Борис');
    const code = await invites.ensureCode(a.id);
    assert.match(code, /^[A-Z2-9]{7}$/);
    assert.equal(await invites.ensureCode(a.id), code, 'код не меняется');
    assert.notEqual(await invites.ensureCode(b.id), code);
    assert.equal(invites.resolve(code.toLowerCase()), a.id);
    assert.equal(invites.resolve('нет такого'), null);
    assert.equal(await invites.attach(a.id, code), false, 'к себе нельзя');
    assert.equal(await invites.attach(b.id, 'ZZZZZZZ'), false, 'неизвестный код');
    assert.equal(await invites.attach(b.id, code), true);
    assert.equal(await invites.attach(b.id, code), false, 'повторно нельзя');
    await store.close();
});

test('лимит: по одной карточке в день на раздел, разделы считаются отдельно, откат при ошибке', async () => {
    const { reg, invites, clock, store } = await setup();
    const a = await reg('Анна');
    for (const s of ['housing', 'work', 'trips', 'services']) {
        const r = invites.reserve(a.id, s); assert.equal(r.ok, true, s); assert.equal(r.quota.limit, 1);
        assert.equal(invites.reserve(a.id, s).ok, false, s + ': второй за день нельзя');
    }
    const undone = invites.reserve((await reg('Борис')).id, 'work'); undone.undo();
    assert.equal(invites.quota((await reg('Вера')).id, 'work').used, 0);
    assert.equal(invites.quota(a.id, 'неизвестный').section, 'housing');
    clock.t += DAY;
    assert.equal(invites.quota(a.id, 'housing').used, 0, 'на следующие сутки счётчик сброшен');
    assert.equal(invites.reserve(a.id, 'housing').ok, true);
    await store.close();
});

test('друг считается после первой карточки: лимит +1, максимум 5 в день и 5 друзей', async () => {
    const { h, reg, invites, accounts, sent, clock, store } = await setup();
    const a = await reg('Анна');
    const code = await invites.ensureCode(a.id);
    assert.equal(invites.limitFor(a.id), 1);
    const friends = [];
    for (let i = 1; i <= 7; i++) friends.push(await reg('Друг' + i, true, code));
    assert.equal(invites.friendsOf(a.id).length, 7, 'все регистрации видны в списке');
    assert.equal(invites.bonus(a.id), 0, 'пока никто ничего не опубликовал, бонуса нет');

    let r = await postReq(h, friends[0], { section: 'work', kind: 'offer', title: 'Нужен повар' });
    assert.equal(r.code, 200);
    assert.equal(invites.bonus(a.id), 1);
    assert.equal(invites.limitFor(a.id), 2);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].ids, [a.id]);
    assert.equal(sent[0].p.kind, 'invite');

    // вторая карточка того же друга ничего не добавляет (между запросами одного человека должна пройти минута)
    clock.t += 61000;
    r = await postReq(h, friends[0], { section: 'trips', kind: 'seek', title: 'Еду в Сочи', city: 'Сочи' });
    assert.equal(r.code, 200);
    assert.equal(invites.bonus(a.id), 1);

    for (let i = 1; i < 7; i++) assert.equal((await postReq(h, friends[i], { city: 'Город' + i })).code, 200, 'друг ' + i);
    assert.equal(invites.bonus(a.id), 5, 'засчитывается не больше пяти');
    assert.equal(invites.limitFor(a.id), 5, 'и не больше пяти карточек в день на раздел');
    const list = invites.friendsOf(a.id);
    assert.equal(list.filter(x => x.counted).length, 5);
    assert.equal(list.filter(x => x.done).length, 7);
    assert.equal(sent.length, 5, 'уведомление только за засчитанных');
    assert.equal(accounts.byId(friends[0].id).name, 'Друг1');
    await store.close();
});

test('HTTP: объявления и услуги упираются в лимит раздела, правка бесплатна, ошибка не тратит лимит', async () => {
    const { h, reg, invites, store } = await setup();
    const a = await reg('Анна');
    let r = await saveAd(h, a, 1); assert.equal(r.code, 200); assert.equal(r.body.quota.used, 1); assert.equal(r.body.quota.limit, 1);
    const id = r.body.listing.id;
    r = await saveAd(h, a, 2); assert.equal(r.code, 429); assert.equal(r.body.code, 'DAILY_LIMIT'); assert.equal(r.body.quota.left, 0);
    assert.match(r.body.message, /Жильё/); assert.match(r.body.message, /Пригласите друга/);
    r = await saveAd(h, a, '1 правка', id); assert.equal(r.code, 200, 'правка бесплатна');

    // услуги считаются отдельно
    const s1 = res(); await h.serviceSave(req({ headers: a.hdr, ip: '8.8.8.1', body: SVC(1) }), s1);
    assert.equal(s1.code, 200, JSON.stringify(s1.body));
    const s2 = res(); await h.serviceSave(req({ headers: a.hdr, ip: '8.8.8.2', body: SVC(2) }), s2);
    assert.equal(s2.code, 429); assert.match(s2.body.message, /Развлечения/);

    // непроверенный хозяин тоже может разместить объявление, лимит раздела считается как у всех
    const c = await reg('Вера', false);
    r = await saveAd(h, c, 1); assert.equal(r.code, 200); assert.equal(r.body.listing.isVerified, false);
    assert.equal(invites.quota(c.id, 'housing').used, 1);

    // запросы: раздел «Работа» отдельно от «Жильё»
    r = await postReq(h, a, { section: 'work', kind: 'seek', title: 'Ищу работу' }); assert.equal(r.code, 200);
    r = res(); await h.requestCreate(req({ headers: a.hdr, ip: '6.1.1.1', body: REQ({ section: 'work', kind: 'offer', title: 'Нужен повар' }) }), r);
    assert.equal(r.code, 429);
    const q = res(); h.listingQuota(req({ headers: a.hdr }), q);
    assert.equal(q.body.quota.used, 1);
    await store.close();
});

test('HTTP: друг по ссылке даёт хозяину +1, эндпоинт «Мои друзья» показывает код, список и лимиты', async () => {
    const { h, reg, invites, store } = await setup();
    const a = await reg('Анна');
    let m = res(); await h.invitesMe(req({ headers: a.hdr }), m);
    assert.equal(m.body.ok, true);
    const code = m.body.code;
    assert.equal(m.body.limit, 1); assert.equal(m.body.counted, 0); assert.deepEqual(m.body.friends, []);
    assert.equal(m.body.quotas.work.limit, 1);

    const b = await reg('Борис', false, code);
    m = res(); await h.invitesMe(req({ headers: a.hdr }), m);
    assert.deepEqual(m.body.friends, [{ name: 'Борис', done: false, counted: false }]);

    assert.equal((await postReq(h, b, { city: 'Анапа' })).code, 200);
    m = res(); await h.invitesMe(req({ headers: a.hdr }), m);
    assert.deepEqual(m.body.friends, [{ name: 'Борис', done: true, counted: true }]);
    assert.equal(m.body.counted, 1); assert.equal(m.body.limit, 2);

    // теперь две карточки жилья в день, третья нет
    assert.equal((await saveAd(h, a, 1)).code, 200);
    assert.equal((await saveAd(h, a, 2)).code, 200);
    assert.equal((await saveAd(h, a, 3)).code, 429);

    const none = res(); await h.invitesMe(req({}), none); assert.equal(none.code, 401);
    // без invites эндпоинта нет
    assert.ok(invites);
    await store.close();
});

test('приглашения переживают перезапуск', async () => {
    const { reg, invites, cfg, accounts, store } = await setup();
    const a = await reg('Анна');
    const code = await invites.ensureCode(a.id);
    const b = await reg('Борис', true, code);
    await invites.attach(b.id, code);                 // уже привязан при регистрации? нет — handler привязывает сам
    await invites.qualify(b.id);
    const again = new InviteStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger: silent }); await again.init();
    assert.equal(again.resolve(code), a.id);
    assert.equal(again.bonus(a.id), 1);
    assert.equal(again.limitFor(a.id), 2);
    await store.close();
});
