'use strict';
// ============================================
// Центр уведомлений: уведомления хранятся на сервере, поэтому колокольчик
// показывает одно и то же на всех устройствах пользователя.
//  • одинаковые непрочитанные (по tag) склеиваются в одно со счётчиком «×N»;
//  • у каждого пользователя хранится не больше 100 уведомлений;
//  • настройки по типам: сообщения, предложения жилья, подходящее жильё, запросы.
//    Системные (проверка хозяина, удаление объявления) отключить нельзя.
// ============================================
const crypto = require('crypto');
const path = require('path');
const { JsonFile } = require('./jsonfile');

const GROUP_OF = { dm: 'messages', group: 'messages', reply: 'messages', invite: 'messages', offer: 'offers', match: 'matches', request: 'requests', review: 'reviews', search: 'searches', verify: 'system', listing: 'system' };
const GROUPS = ['messages', 'offers', 'matches', 'requests', 'reviews', 'searches'];
const CAP = 100;

class Inbox {
    constructor({ dataDir, now = Date.now, logger = console, fsImpl, saveDelayMs = 500 }) {
        this.file = new JsonFile({ file: path.join(dataDir, 'inbox.json'), fsImpl });
        this.now = now; this.logger = logger; this.saveDelayMs = saveDelayMs;
        this.data = { items: {}, prefs: {} };
        this.timer = null;
    }

    async init() {
        const d = await this.file.load({});
        this.data = { items: d.items || {}, prefs: d.prefs || {} };
    }

    _save() {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.file.save(this.data).catch((e) => this.logger.error?.(`inbox: ${e.code || e.message}`));
        }, this.saveDelayMs);
        if (this.timer.unref) this.timer.unref();
    }
    async flush() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } await this.file.save(this.data); }

    groupOf(kind) { return GROUP_OF[kind] || 'messages'; }
    allowed(userId, kind) {
        const g = this.groupOf(kind);
        if (g === 'system') return true;
        const p = this.data.prefs[userId];
        return !(p && p[g] === false);
    }

    // Возвращает { ok, id } или { skipped:true } (если пользователь отключил этот тип)
    add(userId, p) {
        if (!this.allowed(userId, p.kind)) return { skipped: true };
        const list = this.data.items[userId] || (this.data.items[userId] = []);
        const t = this.now();
        const same = p.tag ? list.find(x => !x.read && x.tag === p.tag) : null;
        let it;
        if (same) { it = same; it.count = (it.count || 1) + 1; it.body = p.body; it.title = p.title; it.time = t; list.splice(list.indexOf(it), 1); list.unshift(it); }
        else {
            it = { id: 'n_' + crypto.randomBytes(6).toString('hex'), kind: p.kind, title: p.title, body: p.body, open: p.open || '', tag: p.tag || '', time: t, read: false, count: 1 };
            list.unshift(it);
        }
        if (list.length > CAP) list.length = CAP;
        this._save();
        return { ok: true, id: it.id };
    }

    unread(userId) { return (this.data.items[userId] || []).filter(x => !x.read).length; }

    list(userId, limit = 50) {
        const items = (this.data.items[userId] || []).slice(0, Math.min(limit, CAP)).map(x => ({ id: x.id, kind: x.kind, title: x.title, body: x.body, open: x.open, time: x.time, read: x.read, count: x.count || 1 }));
        return { items, unread: this.unread(userId) };
    }

    // sel: { all:true } | { ids:[...] } | { open:'dm:ID' }
    markRead(userId, sel) {
        const list = this.data.items[userId] || [];
        let n = 0;
        for (const it of list) {
            if (it.read) continue;
            if ((sel && sel.all) || (sel && Array.isArray(sel.ids) && sel.ids.includes(it.id)) || (sel && typeof sel.open === 'string' && sel.open && it.open === sel.open)) { it.read = true; n++; }
        }
        if (n) this._save();
        return { changed: n, unread: this.unread(userId) };
    }

    prefs(userId) {
        const p = this.data.prefs[userId] || {};
        const out = {};
        for (const g of GROUPS) out[g] = p[g] !== false;
        return out;
    }
    setPref(userId, group, on) {
        if (!GROUPS.includes(group)) return false;
        const p = this.data.prefs[userId] || (this.data.prefs[userId] = {});
        if (on) delete p[group]; else p[group] = false;
        if (!Object.keys(p).length) delete this.data.prefs[userId];
        this._save();
        return true;
    }
}

module.exports = { Inbox, GROUPS, GROUP_OF };
