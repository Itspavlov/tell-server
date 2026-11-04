'use strict';
// ============================================
// Socket.IO: события, проверки, лимиты.
// Логика не зависит от настоящей библиотеки (io и socket передаются
// снаружи), поэтому проверяется тестами с поддельными объектами.
//
// Общие комнаты (совместимы с прежним клиентом):
//   клиент -> сервер: join-room, leave-room, send-message, react
//   сервер -> клиент: room-history, new-message, reaction-update, room-cleared,
//                     server-hello {protocol:2}, send-error
// Личные сообщения (только для вошедших в аккаунт):
//   dm-open, dm-list, dm-history, dm-send  (все с ack);  сервер -> dm-message
// Событие clear-room УДАЛЕНО: удалять сообщения через сокет нельзя.
// ============================================

const crypto = require('crypto');
const { getClientIp } = require('./net');
const { isOriginAllowed } = require('./config');
const { fail, validateSend, avatarFor, isValidRoom, normalizeName, REACTIONS } = require('./validate');
const { StoreError } = require('./store');
const { nameKey } = require('./accounts');

const KNOWN_EVENTS = new Set([
    'join-room', 'leave-room', 'send-message', 'react',
    'dm-open', 'dm-list', 'dm-history', 'dm-send'
]);

function newMessageId() {
    return 'msg_' + Date.now() + '_' + crypto.randomBytes(6).toString('hex');
}

function createSocketLayer({ io, cfg, store, accounts, dms, limiters, logger = console, now = Date.now, newId = newMessageId }) {
    const conns = new Map(); // ip -> число соединений

    function allowRequest(req, cb) {
        const origin = req.headers && req.headers.origin;
        if (!isOriginAllowed(origin, cfg)) return cb('origin not allowed', false);
        const ip = getClientIp({ headers: req.headers, address: req.socket && req.socket.remoteAddress }, cfg.trustProxy);
        if (!limiters.connect.hit(ip).ok) return cb('too many connections', false);
        cb(null, true);
    }

    function onConnection(socket) {
        const ip = getClientIp(socket.handshake, cfg.trustProxy);
        const current = conns.get(ip) || 0;
        if (current >= cfg.limits.maxConnectionsPerIp) {
            logger.warn?.('Отклонено соединение: слишком много с одного адреса');
            socket.disconnect(true);
            return;
        }
        conns.set(ip, current + 1);

        // Аккаунт определяется по токену, а не по тому, что пишет клиент
        const token = socket.handshake && socket.handshake.auth && socket.handshake.auth.token;
        const account = accounts && token ? accounts.authenticate(token) : null;
        if (account) socket.join('user:' + account.id);

        const state = { joined: new Set(), violations: 0, lastText: '', lastTextAt: 0 };

        function violation(reason) {
            state.violations++;
            if (state.violations >= cfg.limits.violationLimit) {
                logger.warn?.(`Отключён за нарушения (${reason})`);
                socket.disconnect(true);
            }
        }

        function reply(ack, result) {
            if (typeof ack === 'function') ack(result);
            else if (!result.ok) socket.emit('send-error', { code: result.code, message: result.message });
        }

        function rateOk(ack) {
            if (!limiters.msgSocket.hit(socket.id).ok || !limiters.msgIp.hit(ip).ok) {
                violation('msg-rate');
                reply(ack, fail('RATE_LIMITED'));
                return false;
            }
            return true;
        }

        socket.emit('server-hello', { protocol: 2, user: account ? { id: account.id, name: account.name } : null });

        socket.onAny((event) => {
            if (!KNOWN_EVENTS.has(event)) violation('unknown-event');
        });

        // ---------------- общие комнаты ----------------
        const viewerKey = () => account ? 'u' + account.id : null;

        socket.on('join-room', (room, ack) => {
            if (!limiters.joinSocket.hit(socket.id).ok) { violation('join-rate'); return reply(ack, fail('RATE_LIMITED')); }
            if (!isValidRoom(room, cfg.rooms)) { violation('bad-room'); return reply(ack, fail('INVALID_ROOM')); }
            socket.join(room);
            state.joined.add(room);
            const { messages } = store.getHistory(room, { limit: cfg.limits.historyDefault, viewer: viewerKey() });
            socket.emit('room-history', messages);
            if (typeof ack === 'function') ack({ ok: true, room });
        });

        socket.on('leave-room', (room) => {
            if (!isValidRoom(room, cfg.rooms)) return;
            socket.leave(room);
            state.joined.delete(room);
        });

        socket.on('send-message', async (data, ack) => {
            try {
                if (!rateOk(ack)) return;

                // Вошедший пользователь пишет под именем своего аккаунта
                if (account && data && typeof data === 'object' && !Array.isArray(data)) data = { ...data, user: account.name };

                const v = validateSend(data, cfg.limits, cfg.rooms);
                if (!v.ok) {
                    if (v.code === 'BAD_PAYLOAD' || v.code === 'INVALID_ROOM') violation(v.code);
                    return reply(ack, v);
                }
                const { room, user, text, image, clientId, replyTo } = v.value;

                // Гость не может писать под именем зарегистрированного человека
                if (!account && accounts && accounts.isNameTaken(nameKey(user))) return reply(ack, fail('NAME_TAKEN'));

                if (!state.joined.has(room)) {
                    if (!clientId && typeof ack !== 'function') {
                        socket.join(room);
                        state.joined.add(room);
                    } else {
                        return reply(ack, fail('NOT_IN_ROOM'));
                    }
                }

                const key = clientId ? `${room}|${clientId}` : null;
                const isRetry = key && store.isKnown(key);

                if (!isRetry) {
                    if (image && !limiters.imgIp.hit(ip).ok) return reply(ack, fail('RATE_LIMITED'));
                    if (text && !image) {
                        const norm = text.toLowerCase();
                        if (norm === state.lastText && now() - state.lastTextAt < cfg.limits.dupWindowMs) {
                            return reply(ack, fail('DUPLICATE_TEXT'));
                        }
                    }
                }

                const message = { id: newId(), user, text, avatar: avatarFor(user), image, time: now() };
                if (replyTo) {
                    const src = store.findMessage(room, replyTo);
                    if (src) {
                        message.reply = {
                            id: src.id, user: String(src.user || '').slice(0, 40),
                            text: src.text ? String(src.text).slice(0, 100) : (src.image ? '📷 Фото' : '')
                        };
                    }
                }
                const res = await store.append(room, message, key);

                if (!res.duplicate) {
                    state.lastText = text.toLowerCase();
                    state.lastTextAt = now();
                    io.to(room).emit('new-message', { ...store.publicView(res.message), room });
                }
                reply(ack, { ok: true, id: res.message.id, time: res.message.time, duplicate: res.duplicate });
            } catch (err) {
                if (err instanceof StoreError) {
                    return reply(ack, fail(err.code === 'STORE_FULL' ? 'STORE_FULL' : 'STORE_UNAVAILABLE'));
                }
                logger.error?.(`send-message: ${err && err.message}`);
                reply(ack, fail('SERVER_ERROR'));
            }
        });

        // Реакция: повторное нажатие снимает её
        socket.on('react', async (data, ack) => {
            try {
                if (!limiters.reactSocket.hit(socket.id).ok || !limiters.reactIp.hit(ip).ok) {
                    violation('react-rate');
                    return reply(ack, fail('RATE_LIMITED'));
                }
                if (!data || typeof data !== 'object' || !isValidRoom(data.room, cfg.rooms) ||
                    typeof data.id !== 'string' || data.id.length > 80 || !REACTIONS.includes(data.emoji)) {
                    violation('bad-react');
                    return reply(ack, fail('BAD_REACTION'));
                }
                if (!state.joined.has(data.room)) return reply(ack, fail('NOT_IN_ROOM'));

                let voter;
                if (account) voter = 'u' + account.id;
                else {
                    const n = normalizeName(data.user, cfg.limits);
                    if (!n.ok) return reply(ack, n);
                    if (accounts && accounts.isNameTaken(nameKey(n.value))) return reply(ack, fail('NAME_TAKEN'));
                    voter = 'g' + nameKey(n.value);
                }
                const r = await store.react(data.room, data.id, data.emoji, voter);
                io.to(data.room).emit('reaction-update', { room: data.room, id: data.id, reactions: r.counts });
                reply(ack, { ok: true, reactions: r.counts, mine: r.mine });
            } catch (err) {
                if (err instanceof StoreError) {
                    return reply(ack, fail(err.code === 'STORE_UNAVAILABLE' ? 'STORE_UNAVAILABLE' : err.code));
                }
                logger.error?.(`react: ${err && err.message}`);
                reply(ack, fail('SERVER_ERROR'));
            }
        });

        // ---------------- личные сообщения ----------------
        const needAuth = (ack) => {
            if (account && dms) return true;
            reply(ack, fail('AUTH_REQUIRED'));
            return false;
        };

        socket.on('dm-open', async (data, ack) => {
            try {
                if (!needAuth(ack)) return;
                if (!limiters.joinSocket.hit(socket.id).ok) return reply(ack, fail('RATE_LIMITED'));
                if (!data || typeof data !== 'object') return reply(ack, fail('BAD_PAYLOAD'));
                reply(ack, await dms.open(account, data.ownerName, { id: data.adId, title: data.adTitle }));
            } catch (e) { logger.error?.(`dm-open: ${e && e.message}`); reply(ack, fail('SERVER_ERROR')); }
        });

        socket.on('dm-list', (ack) => {
            if (typeof ack !== 'function') return;
            if (!needAuth(ack)) return;
            ack({ ok: true, convs: dms.list(account) });
        });

        socket.on('dm-history', (data, ack) => {
            if (typeof ack !== 'function') return;
            if (!needAuth(ack)) return;
            if (!limiters.joinSocket.hit(socket.id).ok) return ack(fail('RATE_LIMITED'));
            if (!data || typeof data !== 'object') return ack(fail('BAD_PAYLOAD'));
            const before = typeof data.before === 'string' && data.before.length < 80 ? data.before : null;
            ack(dms.history(account, data.convId, { limit: cfg.limits.historyDefault, before }));
        });

        socket.on('dm-send', async (data, ack) => {
            try {
                if (!needAuth(ack)) return;
                if (!rateOk(ack)) return;
                if (!data || typeof data !== 'object') return reply(ack, fail('BAD_PAYLOAD'));
                const res = await dms.send(account, data.convId, data.text, data.clientId === undefined ? null : data.clientId);
                if (!res.ok) return reply(ack, res);
                if (!res.duplicate) {
                    for (const id of new Set(res.recipients)) io.to('user:' + id).emit('dm-message', res.message);
                }
                reply(ack, { ok: true, id: res.message.id, time: res.message.time, duplicate: !!res.duplicate });
            } catch (e) { logger.error?.(`dm-send: ${e && e.message}`); reply(ack, fail('SERVER_ERROR')); }
        });

        socket.on('disconnect', () => {
            const n = (conns.get(ip) || 1) - 1;
            if (n <= 0) conns.delete(ip); else conns.set(ip, n);
            limiters.msgSocket.delete(socket.id);
            limiters.joinSocket.delete(socket.id);
            limiters.reactSocket.delete(socket.id);
        });
    }

    return { allowRequest, onConnection, connectionCount: (ip) => conns.get(ip) || 0 };
}

module.exports = { createSocketLayer, KNOWN_EVENTS, newMessageId };
