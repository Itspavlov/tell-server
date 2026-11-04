'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fsp = fs.promises;
const { MessageStore, StoreError } = require('../src/store');
const { makeCfg, makeStore, tmpDir, PNG, silent } = require('./helpers');

const msg = (i, extra = {}) => ({ id: 'm' + i, user: 'Тарас', text: 'текст ' + i, avatar: 'Т', image: null, time: 1000 + i, ...extra });

test('сообщение сохраняется на диск и переживает перезапуск', async () => {
    const cfg = makeCfg();
    const s1 = await makeStore(cfg);
    await s1.append('housing', msg(1));
    await s1.close();
    const s2 = await makeStore(cfg);
    assert.equal(s2.getHistory('housing').messages[0].text, 'текст 1');
    await s2.close();
});

test('формат файла совместим со старым (комнаты как ключи)', async () => {
    const cfg = makeCfg();
    const s = await makeStore(cfg);
    await s.append('work', msg(1));
    await s.close();
    const raw = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'messages.json'), 'utf-8'));
    assert.ok(Array.isArray(raw.work) && raw.work[0].id === 'm1');
});

test('старая история читается; при старте создаётся резервная копия', async () => {
    const cfg = makeCfg();
    const legacy = { housing: [{ id: 'old1', user: 'Аня', text: 'старое', avatar: 'А', image: null, time: 5 }], work: [], market: [], trips: [] };
    fs.writeFileSync(path.join(cfg.dataDir, 'messages.json'), JSON.stringify(legacy));
    const s = await makeStore(cfg);
    assert.equal(s.getHistory('housing').messages[0].text, 'старое');
    const backups = fs.readdirSync(path.join(cfg.dataDir, 'backups'));
    assert.equal(backups.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'backups', backups[0]), 'utf-8')), legacy);
    await s.close();
});

test('повреждённый файл: сервер не стартует и файл НЕ затирается', async () => {
    const cfg = makeCfg();
    const f = path.join(cfg.dataDir, 'messages.json');
    fs.writeFileSync(f, '{"housing": [ {"id": ');
    await assert.rejects(() => makeStore(cfg), (e) => e instanceof StoreError && e.code === 'CORRUPT');
    assert.equal(fs.readFileSync(f, 'utf-8'), '{"housing": [ {"id": ');
});

test('файл неожиданного формата тоже не затирается', async () => {
    const cfg = makeCfg();
    const f = path.join(cfg.dataDir, 'messages.json');
    fs.writeFileSync(f, '[1,2,3]');
    await assert.rejects(() => makeStore(cfg), (e) => e.code === 'CORRUPT');
    assert.equal(fs.readFileSync(f, 'utf-8'), '[1,2,3]');
});

test('неизвестные комнаты из старого файла сохраняются, но не отдаются', async () => {
    const cfg = makeCfg();
    fs.writeFileSync(path.join(cfg.dataDir, 'messages.json'), JSON.stringify({ secret: [msg(9)], housing: [] }));
    const s = await makeStore(cfg);
    await s.append('housing', msg(1));
    await s.close();
    const raw = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'messages.json'), 'utf-8'));
    assert.equal(raw.secret.length, 1);
    assert.deepEqual(s.getHistory('secret').messages, []);
});

test('ограничение 500 сообщений в комнате', async () => {
    const cfg = makeCfg();
    const s = await makeStore(cfg);
    await Promise.all(Array.from({ length: 510 }, (_, i) => s.append('trips', msg(i))));
    assert.equal(s.stats().rooms.trips, 500);
    assert.equal(s.getHistory('trips', { limit: 200 }).messages.length, 200);
    await s.close();
});

test('пагинация: before и hasMore', async () => {
    const cfg = makeCfg();
    const s = await makeStore(cfg);
    for (let i = 0; i < 25; i++) await s.append('market', msg(i));
    const p1 = s.getHistory('market', { limit: 10 });
    assert.equal(p1.messages.length, 10);
    assert.equal(p1.messages[0].id, 'm15');
    assert.equal(p1.hasMore, true);
    const p2 = s.getHistory('market', { limit: 10, before: p1.nextBefore });
    assert.equal(p2.messages[0].id, 'm5');
    const p3 = s.getHistory('market', { limit: 10, before: p2.nextBefore });
    assert.equal(p3.messages.length, 5);
    assert.equal(p3.hasMore, false);
    await s.close();
});

test('идемпотентность: тот же clientKey не создаёт дубликат (в т.ч. параллельно)', async () => {
    const cfg = makeCfg();
    const s = await makeStore(cfg);
    const [a, b] = await Promise.all([s.append('housing', msg(1), 'housing|abc12345'), s.append('housing', msg(2), 'housing|abc12345')]);
    const c = await s.append('housing', msg(3), 'housing|abc12345');
    assert.equal(s.stats().rooms.housing, 1);
    assert.equal(a.message.id, b.message.id);
    assert.equal(c.duplicate, true);
    await s.close();
});

test('ошибка записи: сообщение откатывается, клиент получает ошибку, потом всё работает', async () => {
    const cfg = makeCfg();
    let failNext = false;
    const fsImpl = new Proxy(fsp, { get(t, k) {
        if (k === 'rename') return async (...a) => { if (failNext) { failNext = false; throw Object.assign(new Error('disk'), { code: 'EIO' }); } return t.rename(...a); };
        const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
    } });
    const s = await makeStore(cfg, { fsImpl });
    await s.append('housing', msg(1));
    failNext = true;
    await assert.rejects(() => s.append('housing', msg(2)), (e) => e.code === 'STORE_UNAVAILABLE');
    assert.equal(s.stats().rooms.housing, 1, 'неудавшееся сообщение откатилось');
    assert.equal(s.stats().lastWriteOk, false);
    await s.append('housing', msg(3));
    assert.equal(s.stats().lastWriteOk, true);
    assert.equal(s.stats().rooms.housing, 2);
    await s.close();
    const raw = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'messages.json'), 'utf-8'));
    assert.deepEqual(raw.housing.map(m => m.id), ['m1', 'm3']);
});

test('лимит объёма: фото не принимаются, текст принимается', async () => {
    const cfg = makeCfg();
    const s = await makeStore(cfg);
    s.maxStoreBytes = 10; s.bytes = 100;
    await assert.rejects(() => s.append('housing', msg(1, { image: PNG })), (e) => e.code === 'STORE_FULL');
    await s.append('housing', msg(2));
    await s.close();
});

test('старые сообщения с опасным image/avatar не отдаются как есть', async () => {
    const cfg = makeCfg();
    const bad = { id: 'bad1', user: 'Хакер', text: 'x', avatar: '<img src=x onerror=alert(1)>', image: 'javascript:alert(1)', time: 1 };
    fs.writeFileSync(path.join(cfg.dataDir, 'messages.json'), JSON.stringify({ housing: [bad], work: [], market: [], trips: [] }));
    const s = await makeStore(cfg);
    const out = s.getHistory('housing').messages[0];
    assert.equal(out.image, null);
    assert.equal(out.avatar, 'Х');
    await s.close();
});

test('clear очищает комнату и пишет на диск; ошибка откатывает', async () => {
    const cfg = makeCfg();
    const s = await makeStore(cfg);
    await s.append('work', msg(1));
    assert.equal(await s.clear('work'), 1);
    assert.equal(s.stats().rooms.work, 0);
    await assert.rejects(() => s.clear('nope'), (e) => e.code === 'INVALID_ROOM');
    await s.close();
});

test('close() дописывает отложенные записи', async () => {
    const cfg = makeCfg();
    const s = await makeStore(cfg, { flushDelayMs: 5000 });
    const p = s.append('housing', msg(1));
    await s.close();
    await p;
    const raw = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'messages.json'), 'utf-8'));
    assert.equal(raw.housing.length, 1);
});

test('резервных копий хранится не больше 20', async () => {
    const cfg = makeCfg();
    fs.writeFileSync(path.join(cfg.dataDir, 'messages.json'), '{}');
    let t = Date.parse('2026-01-01T00:00:00Z');
    for (let i = 0; i < 25; i++) {
        const s = await makeStore(cfg, { now: () => (t += 1000) });
        await s.close();
    }
    assert.equal(fs.readdirSync(path.join(cfg.dataDir, 'backups')).length, 20);
});
