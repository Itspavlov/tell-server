'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanRequest } = require('../src/requests');
const { RequestStore } = require('../src/requests');
const { makeCfg, silent } = require('./helpers');

const T = '2027-03-10';
const W = (o = {}) => ({ section: 'work', kind: 'offer', title: 'Нужен повар', city: 'Архипо-Осиповка', text: 'x', ...o });

test('работа: телефон приводится к +7, скрытие запоминается', () => {
    const r = cleanRequest(W({ phone: '8 (900) 123-45-67', hidePhone: true }), T);
    assert.equal(r.ok, true);
    assert.equal(r.value.phone, '+79001234567');
    assert.equal(r.value.hidePhone, true);
    assert.equal(cleanRequest(W({ phone: 'abc' }), T).ok, false);
    assert.equal(cleanRequest(W({ hidePhone: true }), T).value.hidePhone, false);   // скрывать нечего
});

test('найти сотрудника: вилка зарплаты и период выплат', () => {
    const r = cleanRequest(W({ salaryFrom: 40000, salaryTo: 60000, payPeriod: 'weekly' }), T);
    assert.equal(r.ok, true);
    assert.deepEqual([r.value.salaryFrom, r.value.salaryTo, r.value.payPeriod, r.value.budget], [40000, 60000, 'weekly', 40000]);
    assert.equal(cleanRequest(W({ salaryFrom: 60000, salaryTo: 40000 }), T).ok, false);
    assert.equal(cleanRequest(W({ payPeriod: 'yearly' }), T).ok, false);
    assert.equal(cleanRequest(W({ salaryFrom: 1000, negotiable: true }), T).value.salaryFrom, null);
    const onlyTo = cleanRequest(W({ salaryTo: 50000 }), T);
    assert.equal(onlyTo.value.budget, 50000);
});

test('ищу работу и другие разделы: период и вилка не сохраняются', () => {
    const seek = cleanRequest(W({ kind: 'seek', phone: '+79001234567', salaryFrom: 1000, payPeriod: 'daily' }), T);
    assert.equal(seek.value.phone, '+79001234567');
    assert.equal(seek.value.salaryFrom, undefined);
    const trips = cleanRequest({ section: 'trips', kind: 'offer', title: 'Еду', phone: '+79001234567' }, T);
    assert.equal(trips.value.phone, undefined);
});

test('скрытый телефон видит только владелец', async () => {
    const cfg = makeCfg();
    const store = new RequestStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent });
    await store.init();
    const me = { id: 'u_me', name: 'Анна' };
    const c = await store.create(me, W({ phone: '+79001234567', hidePhone: true }));
    assert.equal(c.ok, true);
    assert.equal(c.request.phone, '+79001234567');                                   // владельцу виден
    const other = store.list({ viewerId: 'u_other', section: 'work' })[0];
    assert.equal(other.phone, ''); assert.equal(other.hidePhone, true);
    const c2 = await store.edit(me, c.request.id, W({ phone: '+79001234567', hidePhone: false }));
    assert.equal(c2.ok, true);
    assert.equal(store.list({ viewerId: 'u_other', section: 'work' })[0].phone, '+79001234567');
});
