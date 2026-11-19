'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SiteStore } = require('../src/site');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { AccountStore } = require('../src/accounts');
const { makeCfg, makeStore, makeIo, limiters, silent, PNG } = require('./helpers');

const TOKEN = 'd'.repeat(40);
const AH = { authorization: 'Bearer ' + TOKEN };
async function setup() {
    const cfg = makeCfg();
    const clock = { t: 1000 };
    const site = new SiteStore({ dataDir: cfg.dataDir, now: () => (clock.t += 1), logger: silent }); await site.init();
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await accounts.init();
    const store = await makeStore(cfg);
    const io = makeIo();
    const admin = createAdmin({ token: TOKEN, dataDir: cfg.dataDir, logger: silent });
    const h = createHandlers({ cfg, store, admin, accounts, site, limiters: limiters(cfg), io, logger: silent });
    return { site, h, io, cfg };
}
const res = () => { const r = { code: 200, body: null, headers: {}, sent: null }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.set = (k, v) => { r.headers[k] = v; return r; }; r.send = b => { r.sent = b; return r; }; return r; };
const req = (o = {}) => ({ ip: '7.7.7.7', params: {}, query: {}, headers: {}, body: {}, ...o });

test('шапка: по умолчанию пусто, правка сохраняется, пустое поле возвращает стандартное', async () => {
    const { site } = await setup();
    assert.deepEqual(site.heroPublic(), { updated: 0 });
    const r = await site.saveHero({ title1: 'Добро', title2: 'пожаловать', tag: 'Лето ждёт', place: 'Архипо-Осиповка' });
    assert.equal(r.ok, true);
    assert.equal(site.heroPublic().title2, 'пожаловать');
    assert.equal((await site.saveHero({ title1: '' })).ok, true);
    assert.equal(site.heroPublic().title1, undefined);
    assert.equal(site.heroPublic().tag, 'Лето ждёт', 'не названные поля не трогаем');
});

test('шапка: слишком длинный текст и плохое фото отклоняются', async () => {
    const { site } = await setup();
    assert.equal((await site.saveHero({ title1: 'я'.repeat(30) })).code, 'HERO_TEXT');
    assert.equal((await site.saveHero({ photo: 'data:image/png;base64,AAAA' })).code, 'IMAGE_INVALID');
    assert.equal((await site.saveHero(null)).code, 'BAD_REQUEST');
});

test('шапка: фото отдаётся отдельным адресом с версией, сброс убирает всё', async () => {
    const { site } = await setup();
    await site.saveHero({ photo: PNG, title1: 'Привет' });
    const pub = site.heroPublic();
    assert.match(pub.photo, /^\/api\/site\/hero\?v=\d+$/);
    assert.equal(site.heroPhoto().mime, 'image/png');
    const v1 = pub.updated;
    await site.saveHero({ tag: 'Новая подпись' });
    assert.ok(site.heroPublic().updated > v1, 'версия растёт при каждой правке');
    await site.saveHero({ reset: true });
    assert.deepEqual(site.heroPublic(), { updated: site.heroPublic().updated });
    assert.equal(site.heroPhoto(), null);
});

test('шапка: читать может любой, менять — только администратор; правка пишется в журнал и рассылается', async () => {
    const { h, io, site } = await setup();
    let r = res(); h.siteGet(req(), r);
    assert.equal(r.body.ok, true);
    r = res(); await h.adminSiteSave(req({ body: { hero: { title1: 'Хак' } } }), r);
    assert.equal(r.code, 401);
    assert.equal(site.heroPublic().title1, undefined);
    r = res(); await h.adminSiteSave(req({ headers: AH, body: { hero: { title1: 'Привет' } } }), r);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.hero.title1, 'Привет');
    assert.ok(io.emitted.some(e => e.ev === 'site-changed'));
    r = res(); h.siteHeroPhoto(req(), r);
    assert.equal(r.code, 404, 'без своего фото отдаём 404, сайт возьмёт стандартное');
    r = res(); await h.adminSiteGet(req({ headers: AH }), r);
    assert.equal(r.body.hero.title1, 'Привет');
});
