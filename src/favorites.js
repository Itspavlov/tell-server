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

    // id объявления (l_…), готовой услуги (s_…) или карточки поездки (r_…)
    async set(userId, listingId, on, listings, services = null, requests = null) {
        if (typeof listingId !== 'string') return fail('LISTING_NOT_FOUND');
        const isSvc = listingId.startsWith('s_'), isReq = listingId.startsWith('r_');
        if (isReq) {
            const rq = requests && requests.get(listingId, userId);
            // убрать из избранного можно всегда, добавить — только живую карточку поездки
            if (on && !(rq && rq.section === 'trips' && rq.status === 'active')) return fail('REQUEST_NOT_FOUND');
        } else if (isSvc ? !(services && services.light(listingId)) : !listings.rawById(listingId)) return fail(isSvc ? 'SERVICE_NOT_FOUND' : 'LISTING_NOT_FOUND');
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

    // Сколько человек добавили объявление в избранное
    countFor(listingId) { let n = 0; for (const l of Object.values(this.data.users)) if (l.includes(listingId)) n++; return n; }

    // Карточки избранного; удалённые объявления отбрасываются
    list(userId, listings) {
        return this.ids(userId).filter(id => !id.startsWith('s_') && !id.startsWith('r_')).map(id => listings.rawById(id)).filter(Boolean).map(l => listings.light(l));
    }

    // Избранные готовые услуги (в том же порядке, удалённые отбрасываются)
    listServices(userId, services, viewerId = null) {
        return this.ids(userId).filter(id => id.startsWith('s_')).map(id => services.light(id, viewerId)).filter(Boolean);
    }
}

// Избранные карточки поездок (удалённые и закрытые отбрасываются)
FavoriteStore.prototype.listRequests = function (userId, requests, viewerId = null) {
    return this.ids(userId).filter(id => id.startsWith('r_')).map(id => requests.get(id, viewerId)).filter(r => r && r.status === 'active' && r.section === 'trips');
};

FavoriteStore.prototype.eraseUser = async function (userId) {
    const prev = this.data.users[userId];
    if (prev === undefined) return 0;
    delete this.data.users[userId];
    try { await this.file.save(this.data); } catch (e) { this.data.users[userId] = prev; throw e; }
    return prev.length;
};

module.exports = { FavoriteStore };
