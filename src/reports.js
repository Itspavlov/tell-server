'use strict';
// ============================================
// Жалобы на контент: объявления, запросы, встречи, услуги, отзывы, сообщения в комнатах и профили.
// (Жалобы на личные диалоги живут в dm.js.) Нужны для магазинов приложений: у пользователя есть способ
// пожаловаться, у модератора — очередь, которую можно разобрать.
// ============================================

const crypto = require('crypto');
const path = require('path');
const { JsonFile } = require('./jsonfile');
const { fail, normalizeText } = require('./validate');

const KINDS = ['listing', 'request', 'dviz', 'service', 'review', 'message', 'user'];
const REASONS = ['spam', 'scam', 'abuse', 'adult', 'other'];
const CAP = 1000, DAY = 24 * 3600 * 1000;

class ReportStore {
    constructor({ dataDir, now = Date.now, logger = console, fsImpl, hideAt = 3 }) {
        this.hideAt = hideAt;          // сколько разных людей должны пожаловаться, чтобы материал скрылся до проверки (0 — выключено)
        this._hid = null;
        this.file = new JsonFile({ file: path.join(dataDir, 'reports.json'), fsImpl });
        this.now = now; this.logger = logger;
        this.data = { items: [] };
    }

    async init() {
        const d = await this.file.load({});
        this.data = { items: Array.isArray(d.items) ? d.items : [] };
        this.logger.info?.(`Жалобы на контент: ${this.data.items.filter(r => r.status === 'open').length} открытых`);
    }

    // target: { ownerId, ownerName, title } — собирает обработчик из нужного хранилища
    async create(user, p, target, meta = {}) {
        if (!KINDS.includes(p.kind)) return fail('BAD_KIND');
        if (typeof p.targetId !== 'string' || !p.targetId || p.targetId.length > 80) return fail('BAD_PAYLOAD');
        if (!REASONS.includes(p.reason)) return fail('BAD_REASON');
        const t = normalizeText(typeof p.text === 'string' ? p.text : '', 300);
        if (!t.ok) return fail('BAD_PAYLOAD');
        if (target && target.ownerId && target.ownerId === user.id) return fail('SELF_REPORT');
        const now = this.now();
        if (this.data.items.some(r => r.reporterId === user.id && r.kind === p.kind && r.targetId === p.targetId && now - r.time < DAY)) return fail('REPORT_DUPLICATE');
        const rep = {
            id: 'cr_' + crypto.randomBytes(6).toString('hex'), time: now, status: 'open',
            kind: p.kind, targetId: p.targetId, reporterId: user.id, reporterName: user.name,
            ownerId: (target && target.ownerId) || '', ownerName: ((target && target.ownerName) || '').slice(0, 60),
            title: ((target && target.title) || '').slice(0, 160),
            reason: p.reason, text: t.value, trusted: meta.trusted !== false
        };
        this.data.items.push(rep);
        this._hid = null;
        const dropped = [];
        while (this.data.items.length > CAP) {
            const i = this.data.items.findIndex(r => r.status !== 'open');
            dropped.push(this.data.items.splice(i >= 0 ? i : 0, 1)[0]);
        }
        try { await this.file.save(this.data); }
        catch (e) {
            const i = this.data.items.indexOf(rep); if (i >= 0) this.data.items.splice(i, 1);
            this.data.items.push(...dropped); this._hid = null;
            return fail('STORE_UNAVAILABLE');
        }
        return { ok: true, id: rep.id };
    }

    count(kind, targetId) { return this.data.items.filter(r => r.kind === kind && r.targetId === targetId).length; }

    list({ status = 'open', limit = 100 } = {}) {
        return this.data.items.filter(r => status === 'all' || r.status === status).slice(-limit).reverse();
    }

    async close(id, note) {
        const r = this.data.items.find(x => x.id === id);
        if (!r) return fail('REPORT_NOT_FOUND');
        const prev = { status: r.status, note: r.note, closedAt: r.closedAt };
        r.status = 'closed'; r.note = String(note || '').slice(0, 200); r.closedAt = this.now(); this._hid = null;
        try { await this.file.save(this.data); }
        catch (e) { Object.assign(r, prev); this._hid = null; return fail('STORE_UNAVAILABLE'); }
        return { ok: true };
    }

    // Удаление аккаунта: стираются жалобы, которые он подавал, и жалобы на его материалы (самих материалов уже нет)
    async eraseUser(userId) {
        const gone = this.data.items.filter(r => r.reporterId === userId || r.ownerId === userId);
        if (!gone.length) return 0;
        const prev = this.data.items;
        this.data.items = prev.filter(r => !gone.includes(r)); this._hid = null;
        try { await this.file.save(this.data); }
        catch (e) { this.data.items = prev; this._hid = null; throw e; }
        return gone.length;
    }

    // Автоскрытие: материал скрыт, пока на него есть открытые жалобы от >= hideAt РАЗНЫХ людей (только от аккаунтов старше суток).
    // Модератор закрывает жалобы — материал возвращается (или удаляет его).
    _calc() {
        if (this._hid) return this._hid;
        const by = new Map();
        for (const r of this.data.items) {
            if (r.status !== 'open' || r.trusted === false) continue;
            const k = r.kind + ':' + r.targetId;
            if (!by.has(k)) by.set(k, new Set());
            by.get(k).add(r.reporterId);
        }
        const hid = new Map();
        for (const [k, set] of by) hid.set(k, set.size);
        this._hid = hid;
        return hid;
    }
    openCount(kind, targetId) { return this._calc().get(kind + ':' + targetId) || 0; }
    isHidden(kind, targetId) { return this.hideAt > 0 && this.openCount(kind, targetId) >= this.hideAt; }
    hiddenIds(kind) {
        const out = new Set();
        if (this.hideAt <= 0) return out;
        for (const [k, n] of this._calc()) if (n >= this.hideAt && k.startsWith(kind + ':')) out.add(k.slice(kind.length + 1));
        return out;
    }
}

module.exports = { ReportStore, KINDS, REASONS };
