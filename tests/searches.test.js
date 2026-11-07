'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { SearchStore, matches, cleanFilter } = require('../src/searches');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
const silent = { info() {}, warn() {}, error() {} };
const F = (o = {}) => cleanFilter({ q: '', min: '', max: '', from: '', to: '', guests: 0, sea: 0, amen: [], verified: false, cat: '', ...o });
const AD = (o = {}) => ({ id: 'l_1', ownerId: 'host', type: 'rent', category: 'apartment', title: 'Студия у моря', description: 'Тихий двор', location: 'Витязево', priceNum: 3000, facts: [{ t: 'до 4 гостей' }], coords: [44.9, 37.3], beach: [44.9, 37.3009], busy: ['2026-12-10'], amenities: ['Wi-Fi', 'Кондиционер'], isVerified: true, ...o });

test('фильтры очищаются и проверяются', () => {
    assert.equal(cleanFilter({ min: 'abc' }), null);
    assert.equal(cleanFilter({ min: 5000, max: 1000 }), null);
    assert.equal(cleanFilter({ sea: 777 }), null);
    assert.equal(cleanFilter({ cat: 'castle' }), null);
    assert.equal(cleanFilter({ from: '2026-12-10', to: '2026-12-01' }), null);
    const f = cleanFilter({ q: '  Витязево  ', max: '4000', amen: ['Wi-Fi', 'Wi-Fi', '<x>', 'Кондиционер'], from: '2026-12-01' });
    assert.equal(f.q, 'Витязево'); assert.equal(f.max, 4000); assert.deepEqual(f.amen, ['Wi-Fi', 'Кондиционер']); assert.equal(f.to, '');
});

test('совпадение с объявлением: цена, место, гости, море, удобства, даты, проверенный, тип', () => {
    assert.equal(matches(F({ q: 'витязево', max: 3500 }), AD()), true);
    assert.equal(matches(F({ max: 2000 }), AD()), false);
    assert.equal(matches(F({ min: 3500 }), AD()), false);
    assert.equal(matches(F({ q: 'Анапа' }), AD()), false);
    assert.equal(matches(F({ guests: 4 }), AD()), true);
    assert.equal(matches(F({ guests: 6 }), AD()), false);
    assert.equal(matches(F({ sea: 300 }), AD()), true);
    assert.equal(matches(F({ sea: 300 }), AD({ beach: [44.95, 37.3] })), false);
    assert.equal(matches(F({ sea: 300 }), AD({ coords: null })), false);
    assert.equal(matches(F({ amen: ['Wi-Fi', 'Кондиционер'] }), AD()), true);
    assert.equal(matches(F({ amen: ['Бассейн'] }), AD()), false);
    assert.equal(matches(F({ from: '2026-12-09', to: '2026-12-12' }), AD()), false);
    assert.equal(matches(F({ from: '2026-12-01', to: '2026-12-05' }), AD()), true);
    assert.equal(matches(F({ verified: true }), AD({ isVerified: false })), false);
    assert.equal(matches(F({ cat: 'house' }), AD()), false);
    assert.equal(matches(F({ cat: 'apartment' }), AD()), true);
});

test('подписки: лимит, дубль, пустой фильтр, удаление, переживают перезапуск', async () => {
    const dir = tmp();
    const s = new SearchStore({ dataDir: dir, logger: silent }); await s.init();
    assert.equal((await s.add('u1', { filter: {} })).code, 'SEARCH_EMPTY');
    assert.equal((await s.add('u1', { filter: { min: 'x' } })).code, 'BAD_PAYLOAD');
    const a = await s.add('u1', { name: 'До 4000', filter: { max: 4000 } });
    assert.equal(a.ok, true);
    assert.equal((await s.add('u1', { filter: { max: 4000 } })).code, 'SEARCH_DUPLICATE');
    for (let i = 1; i < 10; i++) assert.equal((await s.add('u1', { filter: { max: 4000 + i } })).ok, true);
    assert.equal((await s.add('u1', { filter: { max: 9999 } })).code, 'SEARCH_LIMIT');
    const again = new SearchStore({ dataDir: dir, logger: silent }); await again.init();
    assert.equal(again.list('u1').length, 10);
    assert.equal((await again.remove('u2', a.search.id)).code, 'SEARCH_NOT_FOUND');
    assert.equal((await again.remove('u1', a.search.id)).searches.length, 9);
});

test('уведомление: раз на объявление, не хозяину, несколько подписок склеиваются', async () => {
    const s = new SearchStore({ dataDir: tmp(), logger: silent }); await s.init();
    await s.add('u1', { name: 'Дёшево', filter: { max: 4000 } });
    await s.add('u1', { name: 'У моря', filter: { sea: 300 } });
    await s.add('u2', { name: 'Дорого', filter: { min: 9000 } });
    await s.add('host', { name: 'Мой', filter: { max: 4000 } });
    const n = await s.notifyFor(AD());
    assert.equal(n.length, 1); assert.equal(n[0].userId, 'u1'); assert.equal(n[0].count, 2);
    assert.deepEqual(await s.notifyFor(AD()), []);
    assert.equal((await s.notifyFor(AD({ id: 'l_2' }))).length, 1);
});
