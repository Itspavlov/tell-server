'use strict';
// ============================================
// Уведомления пользователям.
//
// Каждое уведомление уходит на устройства пользователя через сокет (событие 'notify'):
// приложение показывает баннер сверху. Если у пользователя нет ни одного открытого
// соединения (приложение закрыто), дополнительно отправляется push.
// ============================================

const cut = (s, n) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

function createNotifier({ io, push = null, inbox = null, logger = console }) {
    const online = new Map();   // userId -> число открытых соединений

    function connected(userId) { online.set(userId, (online.get(userId) || 0) + 1); }
    function disconnected(userId) {
        const n = (online.get(userId) || 1) - 1;
        if (n <= 0) online.delete(userId); else online.set(userId, n);
    }
    const isOnline = (userId) => (online.get(userId) || 0) > 0;

    // payload: { kind, title, body, open?, tag? }; open — куда перейти по нажатию, например 'dm:ID'
    function notify(userIds, payload) {
        const p = {
            kind: String(payload.kind || 'info').slice(0, 20),
            title: cut(payload.title, 60),
            body: cut(payload.body, 140),
            open: payload.open ? String(payload.open).slice(0, 120) : '',
            tag: payload.tag ? String(payload.tag).slice(0, 80) : '',
            time: Date.now()
        };
        for (const id of new Set(userIds || [])) {
            try {
                if (inbox) {
                    const r = inbox.add(id, p);
                    if (r.skipped) continue;                      // пользователь отключил этот тип
                    p.id = r.id;
                }
                const out = inbox ? { ...p, unread: inbox.unread(id) } : p;
                io.to('user:' + id).emit('notify', out);
                if (push && push.enabled() && !isOnline(id)) {
                    push.send(id, out).catch((e) => logger.warn?.(`notify push: ${e && e.message}`));
                }
            } catch (e) { logger.warn?.(`notify: ${e && e.message}`); }
        }
    }

    return { notify, connected, disconnected, isOnline, cut };
}

module.exports = { createNotifier, cut };
