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
    constructor({ dataDir, now = Date.now, logger = console, fsImpl }) {
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
    async create(user, p, target) {
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
            reason: p.reason, text: t.value
        };
        this.data.items.push(rep);
        const dropped = [];
        while (this.data.items.length > CAP) {
            const i = this.data.items.findIndex(r => r.status !== 'open');
            dropped.push(this.data.items.splice(i >= 0 ? i : 0, 1)[0]);
        }
        try { await this.file.save(this.data); }
        catch (e) {
            const i = this.data.items.indexOf(rep); if (i >= 0) this.data.items.splice(i, 1);
            this.data.items.push(...dropped);
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
        r.status = 'closed'; r.note = String(note || '').slice(0, 200); r.closedAt = this.now();
        try { await this.file.save(this.data); }
        catch (e) { Object.assign(r, prev); return fail('STORE_UNAVAILABLE'); }
        return { ok: true };
    }
}

module.exports = { ReportStore, KINDS, REASONS };
