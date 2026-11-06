'use strict';
// Избранное: список объявлений на аккаунте (видно на всех устройствах).
// До 200 штук на человека; удалённые объявления из списка исчезают сами.
const path = require('path');
const { JsonFile } = require('./jsonfile');
const { fail } = require('./validate');

const CAP = 200;

class FavoriteStore {
    constructor({ dataDir, logger = console, fsImpl }) {
        this.file = new JsonFile({ file: path.join(dataDir, 'favorites.json'), fsImpl });
        this.logger = logger;
        this.data = { users: {} };
    }

    async init() {
        const d = await this.file.load({});
        this.data = { users: d.users || {} };
    }

    ids(userId) { return (this.data.users[userId] || []).slice(); }

    async set(userId, listingId, on, listings) {
        if (typeof listingId !== 'string' || !listings.rawById(listingId)) return fail('LISTING_NOT_FOUND');
        const list = this.data.users[userId] || [];
        const had = list.includes(listingId);
        if (on && had) return { ok: true, ids: this.ids(userId) };
        if (!on && !had) return { ok: true, ids: this.ids(userId) };
        if (on && list.length >= CAP) return fail('FAVORITES_FULL');
        const prev = this.data.users[userId];
        this.data.users[userId] = on ? [listingId, ...list] : list.filter(x => x !== listingId);
        if (!this.data.users[userId].length) delete this.data.users[userId];
        try { await this.file.save(this.data); }
        catch (e) { if (prev) this.data.users[userId] = prev; else delete this.data.users[userId]; return fail('STORE_UNAVAILABLE'); }
        return { ok: true, ids: this.ids(userId) };
    }

    // Карточки избранного; удалённые объявления отбрасываются
    list(userId, listings) {
        return this.ids(userId).map(id => listings.rawById(id)).filter(Boolean).map(l => listings.light(l));
    }
}

module.exports = { FavoriteStore };
