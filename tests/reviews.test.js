'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountStore, nameKey } = require('../src/accounts');
const { ListingStore } = require('../src/listings');
const { DmStore } = require('../src/dm');
const { ReviewStore } = require('../src/reviews');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { makeCfg, makeStore, makeIo, limiters, silent, PNG } = require('./helpers');

const PW = 'correct horse 9';
const AD = () => ({
    type: 'rent', title: 'Студия у моря', priceNum: 3000, price: '3 000 ₽/сут', location: 'Анапа', description: 'Уютно',
    photos: [PNG], thumb: PNG, facts: [], amenities: [], terms: [], rules: [], coords: [44.89, 37.31], beach: [44.88, 37.30], busy: [], since: 2024, form: {}
});
async function setup() {
    const cfg = makeCfg();
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const dms = new DmStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger: silent }); await dms.init();
    const listings = new ListingStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger: silent }); await listings.init();
    const reviews = new ReviewStore({ dataDir: cfg.dataDir, accounts, dms, logger: silent }); await reviews.init();
    listings.reviews = reviews;
    const notes = [];
    const notifier = { notify: (ids, p) => notes.push({ ids, p }) };
    const store = await makeStore(cfg);
    const admin = createAdmin({ token: '', dataDir: cfg.dataDir, logger: silent });
    const h = createHandlers({ cfg, store, admin, accounts, listings, reviews, dms, limiters: limiters(cfg), io: makeIo(), notifier, logger: silent });
    const reg = async (n, v) => { const u = await accounts.register(n, PW); if (v) await accounts.setVerified(nameKey(n), true); return u; };
    const host = await reg('Хозяйка', true);
    const l = await listings.save(accounts.byId(host.user.id), { ad: AD(), profile: { phone: '1', about: '', avatar: '' } });
    assert.ok(l.ok, JSON.stringify(l));
    return { cfg, accounts, dms, listings, reviews, h, reg, host, lid: l.listing.id, notes };
}
const res = () => { const r = { code: 200, body: null }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.set = () => r; return r; };
const rq = (t, o = {}) => ({ ip: '4.4.4.4', params: {}, query: {}, body: {}, headers: t ? { authorization: 'Bearer ' + t } : {}, ...o });
async function contact(env, guest) {
    const u = env.accounts.byId(guest.user.id);
    const o = await env.dms.open(u, 'Хозяйка', { id: env.lid, title: 'x' });
    await env.dms.send(u, o.conv.id, 'Здравствуйте');
}
const post = async (env, t, body) => { const r = res(); await env.h.reviewSave(rq(t, { params: { id: env.lid }, body }), r); return r; };

test('без переписки с хозяином отзыв оставить нельзя', async () => {
    const env = await setup(); const g = await env.reg('Гость');
    const r = await post(env, g.token, { rating: 5, text: 'Супер' });
    assert.equal(r.code, 403); assert.equal(r.body.code, 'NEED_CONTACT');
    const st = res(); env.h.reviewsList(rq(g.token, { params: { id: env.lid } }), st);
    assert.equal(st.body.status.can, false);
});

test('после сообщения хозяину: отзыв создаётся, рейтинг считается, хозяин получает уведомление', async () => {
    const env = await setup(); const g = await env.reg('Гость'); await contact(env, g);
    const r = await post(env, g.token, { rating: 4, text: 'Хорошо' });
    assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.rating, 4); assert.equal(r.body.count, 1);
    assert.equal(env.notes.length, 1); assert.deepEqual(env.notes[0].ids, [env.host.user.id]); assert.equal(env.notes[0].p.kind, 'review');
    const g2 = await env.reg('Гость2'); await contact(env, g2);
    await post(env, g2.token, { rating: 5, text: '' });
    const one = env.listings.get(env.lid);
    assert.equal(one.rating, 4.5); assert.equal(one.reviewCount, 2);
    assert.equal(one.owner.rating, 4.5); assert.equal(one.owner.reviews, 2);
});

test('повторный отзыв заменяет прежний и не плодит уведомления', async () => {
    const env = await setup(); const g = await env.reg('Гость'); await contact(env, g);
    await post(env, g.token, { rating: 2, text: 'Плохо' });
    const r = await post(env, g.token, { rating: 5, text: 'Исправили' });
    assert.equal(r.body.count, 1); assert.equal(r.body.rating, 5); assert.equal(env.notes.length, 1);
});

test('валидация: оценка, длина, хозяин, без входа', async () => {
    const env = await setup(); const g = await env.reg('Гость'); await contact(env, g);
    assert.equal((await post(env, g.token, { rating: 0, text: '' })).body.code, 'BAD_RATING');
    assert.equal((await post(env, g.token, { rating: 3.5, text: '' })).body.code, 'BAD_RATING');
    assert.equal((await post(env, g.token, { rating: 5, text: 'я'.repeat(601) })).body.code, 'REVIEW_TOO_LONG');
    assert.equal((await post(env, env.host.token, { rating: 5, text: 'сам себе' })).body.code, 'SELF_REVIEW');
    assert.equal((await post(env, null, { rating: 5, text: '' })).code, 401);
});

test('ответ хозяина: один раз, только хозяин, автор уведомлён', async () => {
    const env = await setup(); const g = await env.reg('Гость'); await contact(env, g);
    const id = (await post(env, g.token, { rating: 5, text: 'Класс' })).body.review.id;
    const reply = async (t, text) => { const r = res(); await env.h.reviewReply(rq(t, { params: { id }, body: { text } }), r); return r; };
    assert.equal((await reply(g.token, 'спасибо')).code, 403);
    assert.equal((await reply(env.host.token, '')).code, 400);
    assert.equal((await reply(env.host.token, 'Приезжайте ещё')).code, 200);
    assert.equal((await reply(env.host.token, 'Ещё раз')).code, 409);
    assert.deepEqual(env.notes[env.notes.length - 1].ids, [g.user.id]);
    const l = res(); env.h.reviewsList(rq(null, { params: { id: env.lid } }), l);
    assert.equal(l.body.items[0].reply.text, 'Приезжайте ещё');
});

test('удаление: автор — своё, чужой — нет; рейтинг пересчитывается', async () => {
    const env = await setup(); const g = await env.reg('Гость'); const o = await env.reg('Другой'); await contact(env, g); await contact(env, o);
    const id = (await post(env, g.token, { rating: 1, text: 'x' })).body.review.id;
    await post(env, o.token, { rating: 5, text: '' });
    const del = async (t) => { const r = res(); await env.h.reviewDelete(rq(t, { params: { id } }), r); return r; };
    assert.equal((await del(o.token)).code, 403);
    assert.equal((await del(g.token)).code, 200);
    assert.equal(env.listings.get(env.lid).rating, 5);
});

test('отзывы переживают перезапуск; удаление объявления чистит отзывы', async () => {
    const env = await setup(); const g = await env.reg('Гость'); await contact(env, g);
    await post(env, g.token, { rating: 3, text: 'ok' });
    const again = new ReviewStore({ dataDir: env.cfg.dataDir, accounts: env.accounts, dms: env.dms, logger: silent }); await again.init();
    assert.equal(again.listingStats(env.lid).count, 1);
    await env.reviews.dropListing(env.lid);
    assert.equal(env.reviews.listingStats(env.lid).count, 0);
});

test('ошибка записи: отзыв откатывается', async () => {
    const env = await setup(); const g = await env.reg('Гость'); await contact(env, g);
    env.reviews.file.save = async () => { throw new Error('disk'); };
    const r = await post(env, g.token, { rating: 5, text: '' });
    assert.equal(r.code, 503); assert.equal(env.reviews.listingStats(env.lid).count, 0);
});

test('публичный профиль: по id и по имени, объявления и отзывы хозяина', async () => {
    const env = await setup(); const g = await env.reg('Гость'); await contact(env, g);
    await post(env, g.token, { rating: 5, text: 'Класс' });
    for (const q of [{ id: env.host.user.id }, { name: 'хозяйка' }]) {
        const r = res(); env.h.userProfile(rq(null, { query: q }), r);
        assert.equal(r.code, 200, JSON.stringify(r.body));
        assert.equal(r.body.user.name, 'Хозяйка'); assert.equal(r.body.user.verified, true);
        assert.equal(r.body.listings.length, 1); assert.equal(r.body.count, 1); assert.equal(r.body.reviews[0].listingTitle, 'Студия у моря');
        assert.equal(r.body.isMe, false);
    }
    const me = res(); env.h.userProfile(rq(env.host.token, { query: { id: env.host.user.id } }), me);
    assert.equal(me.body.isMe, true);
    const none = res(); env.h.userProfile(rq(null, { query: { name: 'Никто' } }), none);
    assert.equal(none.code, 404);
    const mine = res(); env.h.userProfile(rq(g.token, { query: { id: env.host.user.id } }), mine);
    assert.equal(mine.body.reviews[0].mine, true);
});

test('кабинет хозяина: просмотры (без своих), избранное, диалоги, отзывы', async () => {
    const { StatsStore } = require('../src/stats');
    const env = await setup(); const g = await env.reg('Гость'); await contact(env, g);
    await post(env, g.token, { rating: 4, text: '' });
    const stats = new StatsStore({ dataDir: env.cfg.dataDir, logger: silent }); await stats.init();
    const fav = { countFor: () => 3 };
    const h = createHandlers({ cfg: env.cfg, store: await makeStore(env.cfg), admin: createAdmin({ token: '', dataDir: env.cfg.dataDir, logger: silent }), accounts: env.accounts, listings: env.listings, reviews: env.reviews, stats, favorites: fav, dms: env.dms, limiters: limiters(env.cfg), io: makeIo(), logger: silent });
    const get = (t, id) => { const r = res(); h.listingGet(rq(t, { params: { id } }), r); return r; };
    get(g.token, env.lid); get(g.token, env.lid); get(null, env.lid); get(env.host.token, env.lid);
    const r = res(); h.myStats(rq(env.host.token), r);
    assert.equal(r.code, 200, JSON.stringify(r.body));
    const it = r.body.listings[0];
    assert.equal(it.views, 2); assert.equal(it.favorites, 3); assert.equal(it.reviews, 1); assert.equal(it.rating, 4);
    assert.equal(r.body.totals.views7, 2); assert.equal(r.body.totals.chats >= 0, true); assert.equal(it.series.length, 7);
    const no = res(); h.myStats(rq(null), no); assert.equal(no.code, 401);
    const other = await env.reg('Чужой'); const o = res(); h.myStats(rq(other.token), o); assert.deepEqual(o.body.listings, []);
});
