'use strict';
// ============================================
// Игровые комнаты на двоих («Клубничный рейс», онлайн).
// Пространство имён Socket.IO: /game. Сервер ничего не считает и не хранит,
// только сводит двух игроков (продавец и покупатель) и пересылает им
// позы и реплики друг друга. Комнаты живут в памяти.
//
//   клиент -> сервер: g-create {role}  (ack {ok, code, role})
//                     g-join {code, want?} (ack {ok, role, peer, peerRole})
//                     g-leave
//                     g-s   {x, z, yaw, m, c, r}  состояние персонажа (без ack)
//                     g-ev  {t:'say', text} | {t:'act', a, d?:[числа]}  событие
//                     g-w   {w:[числа]}  снимок мира (лодка и акулы), только от продавца
//   сервер -> клиент: g-peer {present, role}, g-s, g-ev, g-w
//
// Логика не зависит от настоящей библиотеки: socket и время передаются
// снаружи, поэтому проверяется тестами с поддельными объектами.
// ============================================

const crypto = require('crypto');
const { getClientIp } = require('./net');

const ROLES = ['seller', 'buyer'];
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // без похожих знаков: 0/O, 1/I
const CODE_LEN = 4;
const MODES = new Set(['idle', 'walk', 'dance', 'sit', 'cheer', 'clap', 'wave', 'flail']);
const CLIP_RE = /^[a-z0-9_]{1,16}$/;
const ACTS = new Set(['give', 'take', 'wave', 'hello', 'ask', 'depart', 'feed', 'throw', 'push', 'fell', 'landed', 'dock', 'bite', 'home', 'sync']);
const MAX_D = 8, MAX_W = 48;

function createGameLayer({ cfg = {}, logger = console, now = Date.now, randomInt = crypto.randomInt, limits = {} } = {}) {
    const L = Object.assign({
        maxRooms: 300,            // всего комнат в памяти
        emptyTtlMs: 10 * 60_000,  // пустая комната живёт столько, чтобы можно было вернуться после обновления страницы
        idleTtlMs: 3 * 3600_000,  // комната без движения
        createPerMin: 6,          // создание комнат с одного соединения
        statePerSec: 30,          // позы
        eventPerSec: 10,          // реплики и действия
        worldPerSec: 15,          // снимки мира
        maxPerIp: 8,              // соединений /game с одного адреса
        maxText: 80,
        bound: 300                // координаты по модулю не больше
    }, limits);

    const rooms = new Map();     // code -> {code, seats:{seller,buyer}, created, last, emptyAt}
    const perIp = new Map();

    function newCode() {
        for (let tries = 0; tries < 50; tries++) {
            let c = '';
            for (let i = 0; i < CODE_LEN; i++) c += ALPHABET[randomInt(ALPHABET.length)];
            if (!rooms.has(c)) return c;
        }
        return null;
    }

    function sweep() {
        const t = now();
        for (const [code, r] of rooms) {
            const empty = !r.seats.seller && !r.seats.buyer;
            if ((empty && t - r.emptyAt > L.emptyTtlMs) || t - r.last > L.idleTtlMs) rooms.delete(code);
        }
    }

    const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= L.bound ? Math.round(v * 100) / 100 : null);
    const ipOf = (socket) => getClientIp(socket.handshake || {}, cfg.trustProxy);

    function bucket(max, perMs) {
        let tokens = max, at = now();
        return () => { const t = now(); tokens = Math.min(max, tokens + (t - at) * max / perMs); at = t; if (tokens < 1) return false; tokens -= 1; return true; };
    }

    function onConnection(socket) {
        const ip = ipOf(socket);
        const cur = perIp.get(ip) || 0;
        if (cur >= L.maxPerIp) { socket.disconnect(true); return; }
        perIp.set(ip, cur + 1);

        let room = null, role = null, violations = 0;
        const okState = bucket(L.statePerSec, 1000), okEvent = bucket(L.eventPerSec, 1000), okWorld = bucket(L.worldPerSec, 1000), okCreate = bucket(L.createPerMin, 60_000);
        const violation = () => { if (++violations > 300) socket.disconnect(true); };
        const reply = (ack, res) => { if (typeof ack === 'function') ack(res); };
        const peerOf = () => (room ? room.seats[role === 'seller' ? 'buyer' : 'seller'] : null);

        function leave() {
            if (!room) return;
            const r = room, my = role; room = null; role = null;
            if (r.seats[my] === socket) r.seats[my] = null;
            const other = r.seats[my === 'seller' ? 'buyer' : 'seller'];
            if (other) other.emit('g-peer', { present: false, role: my });
            else r.emptyAt = now();
        }

        function sit(r, want) {
            const free = ROLES.filter((x) => !r.seats[x]);
            if (!free.length) return null;
            return free.includes(want) ? want : free[0];
        }

        socket.emit('g-hello', { v: 1 });

        socket.on('g-create', (data, ack) => {
            if (typeof data === 'function') { ack = data; data = {}; }
            if (room) return reply(ack, { ok: false, code: 'in-room' });
            if (!okCreate()) { violation(); return reply(ack, { ok: false, code: 'rate' }); }
            sweep();
            if (rooms.size >= L.maxRooms) return reply(ack, { ok: false, code: 'full' });
            const want = data && ROLES.includes(data.role) ? data.role : 'seller';
            const code = newCode();
            if (!code) return reply(ack, { ok: false, code: 'full' });
            const t = now();
            const r = { code, seats: { seller: null, buyer: null }, created: t, last: t, emptyAt: t };
            rooms.set(code, r);
            r.seats[want] = socket; room = r; role = want;
            reply(ack, { ok: true, code, role: want, peer: false });
        });

        socket.on('g-join', (data, ack) => {
            if (typeof data === 'function') { ack = data; data = {}; }
            if (room) return reply(ack, { ok: false, code: 'in-room' });
            if (!okCreate()) { violation(); return reply(ack, { ok: false, code: 'rate' }); }
            const code = clean(data && data.code, CODE_LEN).toUpperCase();
            const r = rooms.get(code);
            if (!r) return reply(ack, { ok: false, code: 'no-room' });
            const mine = sit(r, data && data.want);
            if (!mine) return reply(ack, { ok: false, code: 'full-room' });
            r.seats[mine] = socket; room = r; role = mine; r.last = now();
            const other = r.seats[mine === 'seller' ? 'buyer' : 'seller'];
            if (other) other.emit('g-peer', { present: true, role: mine });
            reply(ack, { ok: true, code, role: mine, peer: !!other, peerRole: other ? (mine === 'seller' ? 'buyer' : 'seller') : null });
        });

        socket.on('g-leave', () => leave());

        // состояние персонажа: положение, поворот, поза, клип, скорость клипа
        socket.on('g-s', (d) => {
            if (!room) return;
            if (!okState()) return violation();
            if (!d || typeof d !== 'object') return violation();
            const x = num(d.x), z = num(d.z), yaw = num(d.yaw);
            if (x === null || z === null || yaw === null) return violation();
            const m = MODES.has(d.m) ? d.m : 'idle';
            const c = typeof d.c === 'string' && CLIP_RE.test(d.c) ? d.c : null;
            const r = num(d.r);
            const peer = peerOf(); room.last = now();
            if (peer) peer.emit('g-s', { x, z, yaw, m, c, r: r === null ? 0 : r });
        });

        // реплики и действия
        socket.on('g-ev', (d) => {
            if (!room) return;
            if (!okEvent()) return violation();
            if (!d || typeof d !== 'object') return violation();
            const peer = peerOf(); room.last = now();
            if (!peer) return;
            if (d.t === 'say') {
                const text = clean(d.text, L.maxText);
                if (text) peer.emit('g-ev', { t: 'say', text });
            } else if (d.t === 'act' && ACTS.has(d.a)) {
                const ev = { t: 'act', a: d.a };
                if (Array.isArray(d.d)) {
                    const arr = d.d.slice(0, MAX_D).map(num);
                    if (arr.some((v) => v === null)) return violation();
                    ev.d = arr;
                }
                peer.emit('g-ev', ev);
            } else violation();
        });

        // снимок мира: лодка и акулы. Считает продавец, покупатель только рисует
        socket.on('g-w', (d) => {
            if (!room || role !== 'seller') return;
            if (!okWorld()) return;
            if (!d || !Array.isArray(d.w) || d.w.length > MAX_W) return violation();
            const w = d.w.map(num);
            if (w.some((v) => v === null)) return violation();
            room.last = now();
            const peer = peerOf();
            if (peer) peer.emit('g-w', { w });
        });

        socket.on('disconnect', () => {
            leave();
            const n = (perIp.get(ip) || 1) - 1;
            if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
        });
    }

    return { onConnection, sweep, roomCount: () => rooms.size, _rooms: rooms };
}

module.exports = { createGameLayer, ROLES };
