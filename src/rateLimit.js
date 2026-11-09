'use strict';
// ============================================
// Ограничитель частоты («скользящее окно»).
// Не требует внешних библиотек, хранит данные в памяти.
// ============================================

class RateLimiter {
    constructor({ windowMs, max, now = Date.now }) {
        this.windowMs = windowMs;
        this.max = max;
        this.now = now;
        this.hits = new Map();   // ключ -> массив времён обращений
    }

    // Регистрирует обращение. ok=false — лимит исчерпан.
    hit(key) {
        const t = this.now();
        const from = t - this.windowMs;
        const list = (this.hits.get(key) || []).filter(x => x > from);
        if (list.length >= this.max) {
            this.hits.set(key, list);
            return { ok: false, retryAfterMs: Math.max(1, list[0] + this.windowMs - t) };
        }
        list.push(t);
        this.hits.set(key, list);
        return { ok: true, remaining: this.max - list.length };
    }

    // Проверка без учёта обращения: можно ли ещё пускать этот ключ
    peek(key) {
        const t = this.now();
        const list = (this.hits.get(key) || []).filter(x => x > t - this.windowMs);
        if (list.length >= this.max) return { ok: false, retryAfterMs: Math.max(1, list[0] + this.windowMs - t) };
        return { ok: true };
    }

    delete(key) { this.hits.delete(key); }

    // Чистка давно неактивных ключей (вызывается по таймеру)
    sweep() {
        const from = this.now() - this.windowMs;
        for (const [k, list] of this.hits) {
            if (!list.length || list[list.length - 1] <= from) this.hits.delete(k);
        }
    }

    get size() { return this.hits.size; }
}

function createLimiters(rates, now) {
    const make = (r) => new RateLimiter({ ...r, now });
    return {
        msgSocket: make(rates.msgPerSocket),
        msgIp: make(rates.msgPerIp),
        imgIp: make(rates.imgPerIp),
        joinSocket: make(rates.joinPerSocket),
        connect: make(rates.connectPerIp),
        http: make(rates.httpPerIp),
        history: make(rates.historyPerIp),
        admin: make(rates.adminPerIp),
        adminFail: make(rates.adminFail),
        reactSocket: make(rates.reactSocket),
        reactIp: make(rates.reactIp),
        registerIp: make(rates.registerIp),
        loginIp: make(rates.loginIp),
        loginName: make(rates.loginName),
        groupCreate: make(rates.groupCreate),
        groupJoin: make(rates.groupJoin),
        groupInvite: make(rates.groupInvite),
        listingSave: make(rates.listingSave),
        verifyRequest: make(rates.verifyRequest),
        pushSub: make(rates.pushSub),
        mediaUpload: make(rates.mediaUpload),
        requestWrite: make(rates.requestWrite),
        reviewWrite: make(rates.reviewWrite),
        serviceWrite: make(rates.serviceWrite),
        dvizWrite: make(rates.dvizWrite),
        dvizTalk: make(rates.dvizTalk)
    };
}

module.exports = { RateLimiter, createLimiters };
