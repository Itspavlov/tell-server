'use strict';
// Иллюстрация вакансии из готовой библиотеки (a01…a70)
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanRequest } = require('../src/requests');

const base = { section: 'work', kind: 'offer', title: 'Официант' };
const today = '2027-03-10';

test('art: id из библиотеки принимается у вакансии', () => {
    for (const id of ['a01', 'a09', 'a10', 'a22', 'a69', 'a70']) {
        const c = cleanRequest({ ...base, art: id }, today);
        assert.equal(c.ok, true, id); assert.equal(c.value.art, id);
    }
});

test('art: чужие и выдуманные значения отклоняются', () => {
    for (const bad of ['a00', 'a71', 'a7', 'A22', 'a22 ', '../a22', 'x', 22, {}, [], '<img>', 'a022']) {
        const c = cleanRequest({ ...base, art: bad }, today);
        assert.equal(c.ok, false, JSON.stringify(bad));
    }
});

test('art: пустая строка убирает картинку, а без поля ключа нет', () => {
    assert.equal(cleanRequest({ ...base, art: '' }, today).value.art, '');
    assert.equal('art' in cleanRequest(base, today).value, false);
});

test('art: у других разделов и у «Ищу работу» поле игнорируется', () => {
    assert.equal('art' in cleanRequest({ ...base, kind: 'seek', art: 'a05' }, today).value, false);
    assert.equal('art' in cleanRequest({ ...base, section: 'trips', art: 'a05' }, today).value, false);
    assert.equal('art' in cleanRequest({ section: 'housing', city: 'Анапа', art: 'a05' }, today).value, false);
});
