'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FavoriteStore } = require('../src/favorites');
const { RequestStore } = require('../src/requests');
const { makeCfg, silent } = require('./helpers');

test('избранное: карточки поездок', async () => {
    const cfg = makeCfg();
    const fav = new FavoriteStore({ dataDir: cfg.dataDir, logger: silent }); await fav.init();
    const reqs = new RequestStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent }); await reqs.init();
    const owner = { id: 'u_o', name: 'Олег' };
    const trip = await reqs.create(owner, { section: 'trips', kind: 'offer', title: 'Еду в Сочи', vehicle: 'bus' });
    const work = await reqs.create({ id: 'u_o2', name: 'Ира' }, { section: 'work', kind: 'seek', title: 'Ищу работу', phone: '' });
    assert.equal(trip.ok, true); assert.equal(work.ok, true);
    const tid = trip.request.id;
    const on = await fav.set('u_me', tid, true, null, null, reqs);
    assert.equal(on.ok, true); assert.deepEqual(on.ids, [tid]);
    assert.equal(fav.listRequests('u_me', reqs, 'u_me').length, 1);
    assert.equal(fav.list('u_me', { rawById: () => null, light: x => x }).length, 0);       // в списке жилья поездок нет
    assert.equal((await fav.set('u_me', work.request.id, true, null, null, reqs)).code, 'REQUEST_NOT_FOUND');   // работа в избранное не идёт
    assert.equal((await fav.set('u_me', 'r_nope', true, null, null, reqs)).code, 'REQUEST_NOT_FOUND');
    assert.equal((await fav.set('u_me', tid, false, null, null, reqs)).ok, true);
    assert.equal(fav.listRequests('u_me', reqs, 'u_me').length, 0);
});
