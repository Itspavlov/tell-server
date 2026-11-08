'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matches, mentions } = require('../src/match');

const L = (location, title, category = 'guest', priceNum = 4500, extra = {}) => ({ ad: { type: 'rent', category, location, title, description: '', priceNum, busy: [], ...extra } });
const REQ = { section: 'housing', category: 'guest', city: 'Архипо-Осиповка', budget: 5000 };

test('город в запросе находит объявление при любом написании', () => {
    assert.equal(matches(REQ, L('Архипо-Осиповка, ул. Горная, 12', 'Гостевой дом Уют')), true);
    assert.equal(matches(REQ, L('Архипо Осиповка, ул. Горная', 'Гостевой дом')), true);
    assert.equal(matches(REQ, L('ул. Горная, в Архипо-Осиповке', 'Гостевой дом')), true);
    assert.equal(matches(REQ, L('АРХИПО-ОСИПОВКА', 'Дом')), true);
});

test('другой город, другая категория и цена выше бюджета не подходят', () => {
    assert.equal(matches(REQ, L('Анапа, ул. Горная', 'Гостевой дом')), false);
    assert.equal(matches(REQ, L('Архипо-Осиповка, Горная 1', 'Дом', 'apartment')), false);
    assert.equal(matches(REQ, L('Архипо-Осиповка, Горная 1', 'Дом', 'guest', 5500)), false);
    assert.equal(matches(REQ, L('Архипо-Осиповка, Горная 1', 'Дом', 'guest', 5000)), true);
});

test('короткие названия и падежи: Анапа / в Анапе, Сочи', () => {
    assert.equal(mentions('Ул. Рождественская, Анапе', 'Анапа'), true);
    assert.equal(mentions('Сочи, центр', 'Сочи'), true);
    assert.equal(mentions('Адлер', 'Сочи'), false);
    assert.equal(mentions('любой текст', ''), true);
});
