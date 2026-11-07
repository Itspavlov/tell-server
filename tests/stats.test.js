'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { StatsStore } = require('../src/stats');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stats-'));
const silent = { info() {}, warn() {}, error() {} };

test('просмотр считается раз в сутки на человека и объявление', async () => {
    let t = Date.UTC(2026, 10, 7, 9, 0, 0);
    const s = new StatsStore({ dataDir: tmp(), now: () => t, logger: silent }); await s.init();
    assert.equal(s.view('l_1', 'u1'), true);
    assert.equal(s.view('l_1', 'u1'), false);
    assert.equal(s.view('l_1', 'ip:1.1.1.1'), true);
    assert.equal(s.view('l_2', 'u1'), true);
    assert.equal(s.summary('l_1').total, 2);
    t += 86400_000;
    assert.equal(s.view('l_1', 'u1'), true);
    const sm = s.summary('l_1');
    assert.equal(sm.total, 3); assert.equal(sm.week, 3);
    assert.deepEqual(sm.series.slice(-2), [2, 1]); assert.equal(sm.series.length, 7);
    await s.flush();
});

test('статистика сохраняется на диск и переживает перезапуск', async () => {
    const dir = tmp();
    const a = new StatsStore({ dataDir: dir, logger: silent }); await a.init();
    a.view('l_9', 'u1'); a.view('l_9', 'u2'); await a.flush();
    const b = new StatsStore({ dataDir: dir, logger: silent }); await b.init();
    assert.equal(b.summary('l_9').total, 2);
    b.drop('l_9'); assert.equal(b.summary('l_9').total, 0); await b.flush();
});

test('старые сутки обрезаются', async () => {
    let t = Date.UTC(2026, 0, 1);
    const s = new StatsStore({ dataDir: tmp(), now: () => t, logger: silent }); await s.init();
    for (let i = 0; i < 70; i++) { s.view('l_1', 'u'); t += 86400_000; }
    assert.ok(Object.keys(s.data.views.l_1.d).length <= 60);
    assert.equal(s.summary('l_1').total, 70);
    await s.flush();
});
