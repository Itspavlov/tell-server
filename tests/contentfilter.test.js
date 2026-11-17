'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkContent } = require('../src/contentfilter');
const { ReportStore } = require('../src/reports');
const { createTelegram } = require('../src/telegram');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { ServiceStore } = require('../src/services');
const { AccountStore } = require('../src/accounts');
const { InviteStore } = require('../src/invites');
const { makeCfg, makeStore, makeIo, limiters, silent } = require('./helpers');

const res = () => { const r = { code: 200, body: null, headers: {} }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.set = (k, v) => { r.headers[k] = v; return r; }; r.setHeader = r.set; return r; };
const req = (o = {}) => ({ ip: '5.5.5.5', params: {}, query: {}, headers: {}, body: {}, ...o });

test('фильтр: «продам машину» в «Жилье», мат, спам, ссылки и нереальная цена не проходят', () => {
    assert.equal(checkContent('housing', { title: 'Продам Toyota Camry', text: '', priceNum: 900000 }).ok, false);
    assert.equal(checkContent('housing', { title: 'Продаю iPhone 15', text: '', priceNum: 5000 }).ok, false);
    assert.equal(checkContent('housing', { title: 'Студия', text: 'х*й', priceNum: 3500 }).reason, 'profanity');
    assert.equal(checkContent('work', { title: 'Заработок в крипте без вложений', text: '' }).reason, 'spam');
    assert.equal(checkContent('housing', { title: 'Дом', text: 'пишите t.me/abc', priceNum: 5000 }).reason, 'link');
    assert.equal(checkContent('housing', { title: 'Студия', text: '', priceNum: 50 }).reason, 'price');
    assert.equal(checkContent('housing', { title: 'Студия', text: '', priceNum: 3000000 }).reason, 'price');
    assert.equal(checkContent('housing', { title: 'Квартира', text: '', priceNum: 1500, long: true }).reason, 'price');
});

test('фильтр: обычные карточки проходят (парковка для авто, «учеба», поездка на авто, телефон в тексте)', () => {
    assert.equal(checkContent('housing', { title: 'Студия у моря', text: 'есть парковка для авто, рядом учеба и магазин', priceNum: 3500 }).ok, true);
    assert.equal(checkContent('housing', { title: 'Квартира на длительный срок', text: 'звоните +7 900 111-22-33', priceNum: 35000, long: true }).ok, true);
    assert.equal(checkContent('trips', { title: 'Еду в Краснодар на авто', text: 'есть места' }).ok, true);
    assert.equal(checkContent('services', { title: 'Морская прогулка на катере', text: 'дельфины, 2 часа' }).ok, true);
    assert.equal(checkContent('work', { title: 'Нужен повар', text: 'график 2/2, сайт cafe.ru' }).ok, true);
});

test('новый аккаунт: в первые сутки не больше двух карточек во всех разделах вместе', async () => {
    const cfg = makeCfg();
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const invites = new InviteStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger: silent }); await invites.init();
    const r = await accounts.register('Новичок', 'correct horse 9');
    const id = (r.user || r.value.user || r.value).id;
    assert.equal(invites.reserve(id, 'housing').ok, true);
    assert.equal(invites.reserve(id, 'work').ok, true);
    const third = invites.reserve(id, 'trips');
    assert.equal(third.ok, false);
    assert.equal(third.quota.newbie, true);
    // через сутки лимит обычный
    accounts.data.users[id].createdAt -= 25 * 3600 * 1000;
    assert.equal(invites.reserve(id, 'trips').ok, true);
});

test('Telegram: удалить по кнопке снимает услугу и закрывает жалобы; чужой нажавший и неверный секрет отклоняются', async () => {
    const cfg = makeCfg();
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const services = new ServiceStore({ dataDir: cfg.dataDir, accounts, logger: silent }); await services.init();
    const reports = new ReportStore({ dataDir: cfg.dataDir, logger: silent, hideAt: 3 }); await reports.init();
    const store = await makeStore(cfg);
    const admin = createAdmin({ token: '', dataDir: cfg.dataDir, logger: silent });
    const sent = [];
    const fakeFetch = async (url, o) => { sent.push({ url, body: JSON.parse(o.body) }); return { json: async () => ({ ok: true }) }; };
    const telegram = createTelegram({ token: 'T', chatId: '777', secret: 'sekret', fetchImpl: fakeFetch, logger: silent });
    const h = createHandlers({ cfg, store, admin, accounts, services, reports, telegram, limiters: limiters(cfg), io: makeIo(), logger: silent });
    services.data.items.s_1 = { id: 's_1', ownerId: 'u_x', ownerName: 'Дурак', title: 'Продам машину', created: Date.now() };
    const rep = (await reports.create({ id: 'u_r', name: 'Аня' }, { kind: 'service', targetId: 's_1', reason: 'spam' }, { ownerId: 'u_x', ownerName: 'Дурак', title: 'Продам машину' }, {})).id;
    await telegram.notifyReport(reports.data.items[0], 1);
    assert.ok(sent[0].url.includes('/botT/sendMessage'));
    assert.ok(JSON.stringify(sent[0].body.reply_markup).includes('del:' + rep));

    let r = res(); await h.tgHook(req({ params: { secret: 'wrong' }, body: {} }), r);
    assert.equal(r.code, 404);
    sent.length = 0;
    r = res(); await h.tgHook(req({ params: { secret: 'sekret' }, body: { callback_query: { id: 'q1', from: { id: 111 }, data: 'del:' + rep, message: { chat: { id: 777 }, message_id: 5, text: 'x' } } } }), r);
    assert.ok(services.data.items.s_1, 'чужой нажавший ничего не удалил');
    assert.ok(sent.some(s => s.url.endsWith('answerCallbackQuery') && /Нет доступа/.test(s.body.text)));

    sent.length = 0;
    r = res(); await h.tgHook(req({ params: { secret: 'sekret' }, body: { callback_query: { id: 'q2', from: { id: 777 }, data: 'del:' + rep, message: { chat: { id: 777 }, message_id: 5, text: 'x' } } } }), r);
    assert.equal(services.data.items.s_1, undefined);
    assert.equal(reports.data.items[0].status, 'closed');
    assert.ok(sent.some(s => s.url.endsWith('editMessageText')));
    await store.close();
});

test('Telegram: в сообщении о жалобе есть ссылка на объявление и кнопка «Открыть на сайте»', async () => {
    const sent = [];
    const fakeFetch = async (url, o) => { sent.push(JSON.parse(o.body)); return { json: async () => ({ ok: true }) }; };
    const tg = createTelegram({ token: 'T', chatId: '1', secret: 's', fetchImpl: fakeFetch, siteUrl: 'https://example.ru/', logger: silent });
    await tg.notifyReport({ id: 'cr_1', kind: 'listing', targetId: 'l_abc', title: 'Дом', ownerName: 'А', reporterName: 'Б', reason: 'spam' }, 1);
    assert.match(sent[0].text, /https:\/\/example\.ru\/\?open=listing%3Al_abc/);
    assert.equal(sent[0].reply_markup.inline_keyboard[0][0].url, 'https://example.ru/?open=listing%3Al_abc');
    assert.match(sent[0].text, /example\.ru\/admin/);
});

test('HTTP: «Продам авто» в «Жилье» отклоняется на сервере (тело запроса — { ad, profile })', async () => {
    const { ListingStore } = require('../src/listings');
    const cfg = makeCfg();
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const listings = new ListingStore({ dataDir: cfg.dataDir, accounts, limits: { ...cfg.limits, dailyListings: 100 }, logger: silent }); await listings.init();
    const store = await makeStore(cfg);
    const admin = createAdmin({ token: '', dataDir: cfg.dataDir, logger: silent });
    const h = createHandlers({ cfg, store, admin, accounts, listings, limiters: limiters(cfg), io: makeIo(), logger: silent });
    let r = res(); await h.register(req({ ip: '8.8.8.1', body: { name: 'Шутник', password: 'correct horse 9' } }), r);
    assert.equal(r.code, 201);
    await accounts.setVerified('шутник', true).catch(() => {});
    const hdr = { authorization: 'Bearer ' + r.body.token };
    const ad = { type: 'rent', category: 'house', title: 'Продам авто', priceNum: 800000, price: '800 000 ₽/сут', location: 'Архипо-Осиповка', description: 'Продам авто срочно', photos: [], facts: [], terms: [], amenities: [] };
    r = res(); await h.listingSave(req({ ip: '8.8.8.1', headers: hdr, body: { ad, profile: {} } }), r);
    assert.equal(r.code, 400);
    assert.equal(r.body.code, 'CONTENT_REJECTED');
    assert.equal(Object.keys(listings.data.listings).length, 0);
    await store.close();
});
