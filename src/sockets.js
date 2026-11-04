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
const { cleanAd } = require('./groups');

const KNOWN_EVENTS = new Set([
    'join-room', 'leave-room', 'send-message', 'react',
    'dm-open', 'dm-list', 'dm-history', 'dm-send', 'dm-delete',
    'group-create', 'group-list', 'group-open', 'group-send', 'group-react',
    'group-invite', 'group-join', 'group-leave', 'ad-reactions', 'ad-react'
]);

function newMessageId() {
    return 'msg_' + Date.now() + '_' + crypto.randomBytes(6).toString('hex');
}

function createSocketLayer({ io, cfg, store, accounts, dms, groups, adReacts, limiters, notifier = null, logger = console, now = Date.now, newId = newMessageId }) {
    const ping = (ids, payload) => { if (notifier) notifier.notify(ids, payload); };
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
        if (account) { socket.join('user:' + account.id); if (notifier) notifier.connected(account.id); }

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

        socket.emit('server-hello', { protocol: 2, user: account ? { id: account.id, name: account.name, verified: !!account.verified } : null });

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
                if (!message.reply && data && data.replyAd) {
                    const ad = cleanAd(data.replyAd);
                    if (ad) message.reply = { id: 'ad_' + ad.id, user: 'Объявление', text: ad.title.slice(0, 100) };
                }
                const res = await store.append(room, message, key);

                if (!res.duplicate) {
                    state.lastText = text.toLowerCase();
                    state.lastTextAt = now();
                    io.to(room).emit('new-message', { ...store.publicView(res.message), room });
                    // ответили на сообщение зарегистрированного человека — сообщаем ему
                    if (message.reply && !String(message.reply.id).startsWith('ad_') && accounts) {
                        const target = accounts.findByKey(nameKey(message.reply.user));
                        if (target && !(account && target.id === account.id)) {
                            ping([target.id], { kind: 'reply', title: user + ' ответил(а) вам', body: text || '📷 Фото', open: 'room:' + room, tag: 'reply:' + room });
                        }
                    }
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
                    ping(res.recipients.filter(id => id !== account.id), { kind: 'dm', title: account.name, body: res.message.text, open: 'dm:' + data.convId, tag: 'dm:' + data.convId });
                }
                reply(ack, { ok: true, id: res.message.id, time: res.message.time, duplicate: !!res.duplicate });
            } catch (e) { logger.error?.(`dm-send: ${e && e.message}`); reply(ack, fail('SERVER_ERROR')); }
        });

        const safe = (name, fn) => async (...args) => {
            const ack = args[args.length - 1];
            try { await fn(...args); }
            catch (e) { logger.error?.(`${name}: ${e && e.message}`); reply(ack, fail('SERVER_ERROR')); }
        };

        socket.on('dm-delete', safe('dm-delete', async (data, ack) => {
            if (!needAuth(ack)) return;
            reply(ack, await dms.remove(account, data && data.convId));
        }));

        // ---------------- группы друзей ----------------
        const needGroups = (ack) => {
            if (account && groups) return true;
            reply(ack, fail('AUTH_REQUIRED'));
            return false;
        };
        const tellMembers = (ids, event, payload) => {
            for (const id of new Set(ids)) io.to('user:' + id).emit(event, payload);
        };
        socket.on('group-create', safe('group-create', async (d, ack) => {
            if (!needGroups(ack)) return;
            if (!limiters.groupCreate.hit(account.id).ok) return reply(ack, fail('RATE_LIMITED'));
            reply(ack, await groups.create(account, d && d.name));
        }));

        socket.on('group-list', (ack) => {
            if (typeof ack !== 'function') return;
            if (!needGroups(ack)) return;
            ack({ ok: true, groups: groups.list(account) });
        });

        socket.on('group-open', (d, ack) => {
            if (typeof ack !== 'function') return;
            if (!needGroups(ack)) return;
            if (!limiters.joinSocket.hit(socket.id).ok) return ack(fail('RATE_LIMITED'));
            if (!d || typeof d !== 'object') return ack(fail('BAD_PAYLOAD'));
            const before = typeof d.before === 'string' && d.before.length < 80 ? d.before : null;
            ack(groups.open(account, d.groupId, { before, limit: cfg.limits.historyDefault }));
        });

        socket.on('group-send', safe('group-send', async (d, ack) => {
            if (!needGroups(ack)) return;
            if (!rateOk(ack)) return;
            if (!d || typeof d !== 'object') return reply(ack, fail('BAD_PAYLOAD'));
            const res = await groups.send(account, d.groupId, { text: d.text, replyTo: d.replyTo, ad: d.ad, clientId: d.clientId === undefined ? null : d.clientId });
            if (!res.ok) return reply(ack, res);
            if (!res.duplicate) {
                tellMembers(res.members, 'group-message', res.message);
                const g = groups.list(account).find(x => x.id === d.groupId);
                ping(res.members.filter(id => id !== account.id), { kind: 'group', title: g ? g.name : 'Группа', body: account.name + ': ' + (res.message.text || (res.message.ad ? '🏠 ' + res.message.ad.title : '')), open: 'group:' + d.groupId, tag: 'group:' + d.groupId });
            }
            reply(ack, { ok: true, id: res.message.id, time: res.message.time, duplicate: !!res.duplicate });
        }));

        socket.on('group-react', safe('group-react', async (d, ack) => {
            if (!needGroups(ack)) return;
            if (!limiters.reactSocket.hit(socket.id).ok || !limiters.reactIp.hit(ip).ok) return reply(ack, fail('RATE_LIMITED'));
            if (!d || typeof d !== 'object') return reply(ack, fail('BAD_PAYLOAD'));
            const res = await groups.react(account, d.groupId, d.id, d.emoji);
            if (!res.ok) return reply(ack, res);
            tellMembers(res.members, 'group-reaction', { groupId: d.groupId, id: d.id, reactions: res.reactions });
            reply(ack, { ok: true, reactions: res.reactions, mine: res.mine });
        }));

        socket.on('group-invite', safe('group-invite', async (d, ack) => {
            if (!needGroups(ack)) return;
            if (!limiters.groupInvite.hit(account.id).ok) return reply(ack, fail('RATE_LIMITED'));
            if (!d || typeof d !== 'object') return reply(ack, fail('BAD_PAYLOAD'));
            const res = await groups.invite(account, d.groupId, d.name);
            if (!res.ok) return reply(ack, res);
            tellMembers(res.members, 'group-members', { groupId: d.groupId, added: res.added });
            io.to('user:' + res.added.id).emit('group-invited', { id: res.group.id, name: res.group.name, by: account.name });
            ping([res.added.id], { kind: 'invite', title: 'Приглашение в группу', body: account.name + ' добавил(а) вас в «' + res.group.name + '»', open: 'group:' + res.group.id, tag: 'invite:' + res.group.id });
            reply(ack, { ok: true, added: res.added });
        }));

        socket.on('group-join', safe('group-join', async (d, ack) => {
            if (!needGroups(ack)) return;
            if (!limiters.groupJoin.hit(ip).ok) return reply(ack, fail('RATE_LIMITED'));
            const res = await groups.join(account, d && d.code);
            if (!res.ok) return reply(ack, res);
            if (res.members) tellMembers(res.members, 'group-members', { groupId: res.group.id, added: { id: account.id, name: account.name } });
            reply(ack, { ok: true, group: res.group, already: !!res.already });
        }));

        socket.on('group-leave', safe('group-leave', async (d, ack) => {
            if (!needGroups(ack)) return;
            const res = await groups.leave(account, d && d.groupId);
            if (!res.ok) return reply(ack, res);
            tellMembers(res.remaining, 'group-members', { groupId: d.groupId, left: { id: account.id, name: account.name } });
            reply(ack, { ok: true });
        }));

        // ---------------- реакции на объявления ----------------
        const adViewer = (userName) => {
            if (account) return { voter: 'u' + account.id };
            const n = normalizeName(userName, cfg.limits);
            if (!n.ok) return { error: n };
            if (accounts && accounts.isNameTaken(nameKey(n.value))) return { error: fail('NAME_TAKEN') };
            return { voter: 'g' + nameKey(n.value) };
        };

        socket.on('ad-reactions', (d, ack) => {
            if (typeof ack !== 'function' || !adReacts) return;
            if (!limiters.joinSocket.hit(socket.id).ok) return ack(fail('RATE_LIMITED'));
            const ids = d && Array.isArray(d.ids) ? d.ids : [];
            const v = account ? { voter: 'u' + account.id } : (d && d.user ? adViewer(d.user) : { voter: null });
            ack({ ok: true, ads: adReacts.many(ids, v.voter || null) });
        });

        socket.on('ad-react', safe('ad-react', async (d, ack) => {
            if (!adReacts) return reply(ack, fail('SERVER_ERROR'));
            if (!limiters.reactSocket.hit(socket.id).ok || !limiters.reactIp.hit(ip).ok) return reply(ack, fail('RATE_LIMITED'));
            if (!d || typeof d !== 'object') return reply(ack, fail('BAD_PAYLOAD'));
            const v = adViewer(d.user);
            if (v.error) return reply(ack, v.error);
            const res = await adReacts.toggle(d.adId, d.emoji, v.voter);
            if (!res.ok) return reply(ack, res);
            io.to('housing').emit('ad-reaction-update', { adId: d.adId, reactions: res.counts });
            reply(ack, { ok: true, reactions: res.counts, mine: res.mine });
        }));

        socket.on('disconnect', () => {
            if (account && notifier) notifier.disconnected(account.id);
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
