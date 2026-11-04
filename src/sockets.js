'use strict';
// ============================================
// Socket.IO: события, проверки, лимиты.
// Логика не зависит от настоящей библиотеки (io и socket передаются
// снаружи), поэтому проверяется тестами с поддельными объектами.
//
// События (совместимы с прежним клиентом):
//   клиент -> сервер: join-room, leave-room, send-message
//   сервер -> клиент: room-history, new-message, room-cleared,
//                     server-hello {protocol:2}, send-error (для клиентов без ack)
// Событие clear-room УДАЛЕНО: удалять сообщения через сокет нельзя.
// ============================================

const crypto = require('crypto');
const { getClientIp } = require('./net');
const { isOriginAllowed } = require('./config');
const { fail, validateSend, avatarFor, isValidRoom } = require('./validate');
const { StoreError } = require('./store');

const KNOWN_EVENTS = new Set(['join-room', 'leave-room', 'send-message']);

function newMessageId() {
    return 'msg_' + Date.now() + '_' + crypto.randomBytes(6).toString('hex');
}

function createSocketLayer({ io, cfg, store, limiters, logger = console, now = Date.now, newId = newMessageId }) {
    const conns = new Map(); // ip -> число соединений

    // Проверка ДО установки соединения (origin и частота подключений)
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
            logger.warn?.(`Отклонено соединение: слишком много с одного адреса`);
            socket.disconnect(true);
            return;
        }
        conns.set(ip, current + 1);

        const state = { joined: new Set(), violations: 0, lastText: '', lastTextAt: 0 };

        function violation(reason) {
            state.violations++;
            if (state.violations >= cfg.limits.violationLimit) {
                logger.warn?.(`Отключён за нарушения (${reason})`);
                socket.disconnect(true);
            }
        }

        function reply(ack, result) {
            if (typeof ack === 'function') {
                ack(result);
            } else if (!result.ok) {
                socket.emit('send-error', { code: result.code, message: result.message });
            }
        }

        // Клиент узнаёт, что сервер новый и умеет подтверждения
        socket.emit('server-hello', { protocol: 2 });

        socket.onAny((event) => {
            if (!KNOWN_EVENTS.has(event)) violation('unknown-event');
        });

        socket.on('join-room', (room, ack) => {
            if (!limiters.joinSocket.hit(socket.id).ok) { violation('join-rate'); return reply(ack, fail('RATE_LIMITED')); }
            if (!isValidRoom(room, cfg.rooms)) { violation('bad-room'); return reply(ack, fail('INVALID_ROOM')); }
            socket.join(room);
            state.joined.add(room);
            const { messages } = store.getHistory(room, { limit: cfg.limits.historyDefault });
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
                if (!limiters.msgSocket.hit(socket.id).ok || !limiters.msgIp.hit(ip).ok) {
                    violation('msg-rate');
                    return reply(ack, fail('RATE_LIMITED'));
                }

                const v = validateSend(data, cfg.limits, cfg.rooms);
                if (!v.ok) {
                    if (v.code === 'BAD_PAYLOAD' || v.code === 'INVALID_ROOM') violation(v.code);
                    return reply(ack, v);
                }
                const { room, user, text, image, clientId } = v.value;

                if (!state.joined.has(room)) {
                    // Старый клиент (без clientId и ack) не знает про подтверждения:
                    // подключаем к комнате автоматически, чтобы его сообщения не пропадали.
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

                const message = {
                    id: newId(), user, text, avatar: avatarFor(user), image, time: now()
                };
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

        socket.on('disconnect', () => {
            const n = (conns.get(ip) || 1) - 1;
            if (n <= 0) conns.delete(ip); else conns.set(ip, n);
            limiters.msgSocket.delete(socket.id);
            limiters.joinSocket.delete(socket.id);
        });
    }

    return { allowRequest, onConnection, connectionCount: (ip) => conns.get(ip) || 0 };
}

module.exports = { createSocketLayer, KNOWN_EVENTS, newMessageId };
