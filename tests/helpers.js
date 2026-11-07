'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../src/config');
const { MessageStore } = require('../src/store');
const { createLimiters } = require('../src/rateLimit');

const silent = { info() {}, warn() {}, error() {} };

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tell-test-')); }

// Минимальный настоящий PNG (1x1)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG = 'data:image/png;base64,' + PNG_B64;

function makeCfg(over = {}) {
    return loadConfig({ NODE_ENV: 'production', DATA_DIR: over.dataDir || tmpDir(), ALLOW_NO_ORIGIN: 'true', ROOM_CHAT: 'on', ...over.env });
}

async function makeStore(cfg, extra = {}) {
    const store = new MessageStore({
        dataDir: cfg.dataDir, rooms: cfg.rooms, roomCap: cfg.limits.roomCap,
        maxStoreBytes: cfg.limits.maxStoreBytes, flushDelayMs: 5, logger: silent, ...extra
    });
    await store.init();
    return store;
}

function makeIo() {
    const emitted = [];
    return { emitted, emit(ev, payload) { emitted.push({ room: '*', ev, payload }); }, to(room) { return { emit(ev, payload) { emitted.push({ room, ev, payload }); } }; } };
}

let sid = 0;
function makeSocket({ ip = '1.1.1.1', headers = {} } = {}) {
    const handlers = {}; const anys = [];
    const s = {
        id: 'sock' + (++sid), rooms: new Set(), out: [], disconnected: false,
        handshake: { address: ip, headers },
        emit(ev, p) { s.out.push({ ev, p }); },
        join(r) { s.rooms.add(r); }, leave(r) { s.rooms.delete(r); },
        disconnect() { s.disconnected = true; if (handlers.disconnect) handlers.disconnect(); },
        on(ev, fn) { handlers[ev] = fn; },
        onAny(fn) { anys.push(fn); },
        // имитация сообщения от клиента
        async fire(ev, ...args) { anys.forEach(f => f(ev, ...args)); if (handlers[ev]) return handlers[ev](...args); },
        sent(ev) { return s.out.filter(o => o.ev === ev).map(o => o.p); }
    };
    return s;
}

function limiters(cfg, now) { return createLimiters(cfg.rates, now); }

module.exports = { silent, tmpDir, PNG, PNG_B64, makeCfg, makeStore, makeIo, makeSocket, limiters };
