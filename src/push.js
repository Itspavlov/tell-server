'use strict';
// ============================================
// Push-уведомления (Web Push, VAPID).
//
// Хранит подписки устройств по пользователям и отправляет уведомления.
// Библиотека web-push подключается лениво: если её нет или ключи VAPID не заданы,
// push отключён, а всё остальное работает как обычно.
// Подписка — это адрес службы push браузера: он не содержит паролей, но считается
// приватным, поэтому в ответах API и журналах не показывается.
// ============================================
const path = require('path');
const { JsonFile } = require('./jsonfile');
const { fail } = require('./validate');

const MAX_PER_USER = 5;
const B64URL = /^[A-Za-z0-9_-]{8,200}$/;

function cleanSubscription(sub) {
    if (!sub || typeof sub !== 'object') return null;
    const endpoint = sub.endpoint;
    if (typeof endpoint !== 'string' || endpoint.length > 600) return null;
    let u;
    try { u = new URL(endpoint); } catch (e) { return null; }
    if (u.protocol !== 'https:') return null;                       // push-службы работают только по HTTPS
    const k = sub.keys;
    if (!k || typeof k.p256dh !== 'string' || typeof k.auth !== 'string') return null;
    if (!B64URL.test(k.p256dh) || !B64URL.test(k.auth)) return null;
    return { endpoint, keys: { p256dh: k.p256dh, auth: k.auth } };
}

class PushStore {
    constructor({ dataDir, logger = console, now = Date.now, fsImpl }) {
        this.file = new JsonFile({ file: path.join(dataDir, 'push.json'), fsImpl });
        this.logger = logger;
        this.now = now;
        this.data = { subs: {} };      // userId -> [{ endpoint, keys, created }]
    }

    async init() {
        const d = await this.file.load({ subs: {} });
        this.data = { subs: d.subs && typeof d.subs === 'object' ? d.subs : {} };
        const n = Object.values(this.data.subs).reduce((a, l) => a + l.length, 0);
        this.logger.info?.(`Push-подписок: ${n}`);
    }

    forUser(userId) { return this.data.subs[userId] || []; }

    async add(userId, rawSub) {
        const sub = cleanSubscription(rawSub);
        if (!sub) return fail('BAD_PAYLOAD');
        const prev = JSON.stringify(this.data.subs);
        // одно устройство — одна запись, у другого пользователя на этом устройстве она переходит к новому
        for (const [id, list] of Object.entries(this.data.subs)) {
            const rest = list.filter(s => s.endpoint !== sub.endpoint);
            if (rest.length) this.data.subs[id] = rest; else delete this.data.subs[id];
        }
        const mine = (this.data.subs[userId] || []).concat([{ ...sub, created: this.now() }]);
        this.data.subs[userId] = mine.slice(-MAX_PER_USER);
        try { await this.file.save(this.data); }
        catch (e) { this.data.subs = JSON.parse(prev); return fail('STORE_UNAVAILABLE'); }
        return { ok: true };
    }

    async removeEndpoint(endpoint, userId = null) {
        const prev = JSON.stringify(this.data.subs);
        let changed = false;
        for (const [id, list] of Object.entries(this.data.subs)) {
            if (userId && id !== userId) continue;
            const rest = list.filter(s => s.endpoint !== endpoint);
            if (rest.length !== list.length) { changed = true; if (rest.length) this.data.subs[id] = rest; else delete this.data.subs[id]; }
        }
        if (!changed) return false;
        try { await this.file.save(this.data); } catch (e) { this.data.subs = JSON.parse(prev); return false; }
        return true;
    }
}

// Отправитель. lib — модуль web-push (в тестах подставляется поддельный).
function createPushSender({ store, vapid, logger = console, lib = null }) {
    let impl = lib;
    let ready = false;
    if (vapid && vapid.publicKey && vapid.privateKey) {
        try {
            impl = impl || require('web-push');
            impl.setVapidDetails(vapid.subject || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);
            ready = true;
        } catch (e) {
            logger.warn?.(`Push отключён: ${e.code === 'MODULE_NOT_FOUND' ? 'не установлен пакет web-push (npm install)' : e.message}`);
        }
    }

    const enabled = () => ready;
    const publicKey = () => (ready ? vapid.publicKey : '');

    // Отправка всем устройствам пользователя. Мёртвые подписки (404/410) удаляются.
    async function send(userId, payload) {
        if (!ready) return { sent: 0 };
        const body = JSON.stringify(payload);
        if (Buffer.byteLength(body) > 3500) return { sent: 0 };
        let sent = 0;
        for (const s of [...store.forUser(userId)]) {
            try {
                await impl.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 3600, urgency: 'high' });
                sent++;
            } catch (e) {
                if (e && (e.statusCode === 404 || e.statusCode === 410)) await store.removeEndpoint(s.endpoint);
                else logger.warn?.(`push: ${e && (e.statusCode || e.code || e.message)}`);
            }
        }
        return { sent };
    }

    return { enabled, publicKey, send };
}

PushStore.prototype.eraseUser = async function (userId) {
    const prev = this.data.subs[userId];
    if (prev === undefined) return 0;
    delete this.data.subs[userId];
    try { await this.file.save(this.data); } catch (e) { this.data.subs[userId] = prev; throw e; }
    return prev.length;
};

module.exports = { PushStore, createPushSender, cleanSubscription };
