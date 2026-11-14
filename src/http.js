'use strict';
// ============================================
// HTTP-маршруты. Обработчики не зависят от express напрямую
// (получают req/res), поэтому проверяются тестами с поддельными объектами.
// ============================================

const { isValidRoom } = require('./validate');
const { isOriginAllowed } = require('./config');
const { fail } = require('./validate');
const { nameKey } = require('./accounts');

function createHandlers({ cfg, store, admin, accounts, listings, requests = null, inbox = null, favorites = null, reviews = null, services = null, dviz = null, stats = null, searches = null, media = null, dms = null, weather = null, invites = null, groups = null, adReacts = null, reports = null, mailer = null, limiters, io, push = null, pushStore = null, notifier = null, logger = console }) {
    const ipOf = (req) => req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';

    function limited(res, r) {
        res.set('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)));
        return res.status(429).json({ error: 'Слишком много запросов' });
    }

    function security(req, res, next) {
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Referrer-Policy', 'no-referrer');
        res.set('Cache-Control', 'no-store');
        next();
    }

    function generalLimit(req, res, next) {
        const r = limiters.http.hit(ipOf(req));
        if (!r.ok) return limited(res, r);
        next();
    }

    function root(req, res) {
        const s = store.stats();
        const total = Object.values(s.rooms).reduce((a, b) => a + b, 0);
        res.json({
            status: 'ok',
            message: 'Tell Server работает',
            time: new Date().toISOString(),
            rooms: cfg.rooms,
            totalMessages: total
        });
    }

    function healthz(req, res) { res.json({ ok: true }); }

    function readyz(req, res) {
        const s = store.stats();
        if (!s.ready || !s.lastWriteOk) return res.status(503).json({ ok: false, ready: s.ready, lastWriteOk: s.lastWriteOk });
        res.json({ ok: true });
    }

    function history(req, res) {
        const r = limiters.history.hit(ipOf(req));
        if (!r.ok) return limited(res, r);
        const room = req.params.room;
        if (!isValidRoom(room, cfg.rooms)) {
            return res.status(404).json({ error: 'Комната не найдена', available: cfg.rooms });
        }
        let limit = parseInt(req.query && req.query.limit, 10);
        if (!Number.isFinite(limit) || limit < 1) limit = cfg.limits.historyDefault;
        limit = Math.min(limit, cfg.limits.historyMax);
        let before = req.query && req.query.before;
        if (typeof before !== 'string' || before.length > 80) before = null;
        const h = store.getHistory(room, { limit, before });
        res.json({ room, count: h.messages.length, messages: h.messages, hasMore: h.hasMore, nextBefore: h.nextBefore });
    }

    // Общая проверка админа. Возвращает true, если можно продолжать.
    async function requireAdmin(req, res, action, extra) {
        if (!admin.isEnabled()) { res.status(404).json({ error: 'Not found' }); return false; }
        const ip = ipOf(req);
        const r = limiters.admin.hit(ip);
        if (!r.ok) { limited(res, r); return false; }
        // подбор токена: после 10 неудач с одного адреса вход закрывается на 15 минут
        const blocked = limiters.adminFail.peek(ip);
        if (!blocked.ok) { limited(res, blocked); return false; }
        if (!admin.authorize(req.headers && req.headers.authorization)) {
            limiters.adminFail.hit(ip);
            await admin.audit('admin_denied', { attempted: action, ip, ...extra });
            res.status(401).json({ error: 'Unauthorized' });
            return false;
        }
        return true;
    }

    async function clearRoom(req, res) {
        const room = req.params.room;
        if (!(await requireAdmin(req, res, 'clear_room', { room: String(room).slice(0, 20) }))) return;
        if (!isValidRoom(room, cfg.rooms)) return res.status(404).json({ error: 'Комната не найдена' });
        try {
            const removed = await store.clear(room);
            await admin.audit('clear_room', { room, removed, ip: ipOf(req) });
            io.to(room).emit('room-cleared');
            res.json({ success: true, message: `Комната ${room} очищена`, removed });
        } catch (e) {
            logger.error?.(`clearRoom: ${e.code || e.message}`);
            res.status(500).json({ error: 'Не удалось очистить комнату' });
        }
    }

    async function exportAll(req, res) {
        if (!(await requireAdmin(req, res, 'export', {}))) return;
        await admin.audit('export', { ip: ipOf(req) });
        res.set('Content-Disposition', 'attachment; filename="messages-export.json"');
        res.json(store.exportAll());
    }

    // ---------- аккаунты ----------
    const bearer = (req) => {
        const m = /^Bearer ([0-9a-f]{64})$/.exec((req.headers && req.headers.authorization) || '');
        return m ? m[1] : null;
    };
    const authFail = (res, r) => res.status(r.code === 'SERVER_ERROR' || r.code === 'TOO_MANY_ACCOUNTS' ? 503 : (r.code === 'BAD_CREDENTIALS' ? 401 : (r.code === 'NAME_TAKEN' ? 409 : 400)))
        .json({ ok: false, code: r.code, message: r.message });

    async function register(req, res) {
        if (!accounts) return res.status(404).json({ error: 'Not found' });
        const rl = limiters.registerIp.hit(ipOf(req));
        if (!rl.ok) return limited(res, rl);
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const r = await accounts.register(b.name, b.password);
        if (!r.ok) return authFail(res, r);
        // пришёл по ссылке друга: запоминаем, кто пригласил (засчитается, когда новичок опубликует карточку)
        if (invites && typeof b.ref === 'string') { try { await invites.attach(r.user.id, b.ref); } catch (e) { logger.warn?.(`invites attach: ${e && e.message}`); } }
        if (b.consent === true) { try { await accounts.markConsent(r.user.id, typeof b.consentVersion === 'string' ? b.consentVersion : '1'); } catch (e) { logger.warn?.(`consent: ${e && e.message}`); } }
        res.status(201).json({ ok: true, token: r.token, user: r.user, recoveryCode: r.recoveryCode });
    }

    async function login(req, res) {
        if (!accounts) return res.status(404).json({ error: 'Not found' });
        const rl = limiters.loginIp.hit(ipOf(req));
        if (!rl.ok) return limited(res, rl);
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        if (typeof b.name === 'string') {
            const rn = limiters.loginName.hit(nameKey(b.name).slice(0, 40));
            if (!rn.ok) return limited(res, rn);
        }
        const r = await accounts.login(b.name, b.password);
        if (!r.ok) return authFail(res, r);
        res.json({ ok: true, token: r.token, user: r.user });
    }

    async function logout(req, res) {
        if (!accounts) return res.status(404).json({ error: 'Not found' });
        await accounts.logout(bearer(req));
        res.json({ ok: true });
    }

    // Смена имени: имя — это и логин, и подпись везде, поэтому копии имени в чужих данных обновляем сразу
    async function rename(req, res) {
        if (!accounts) return res.status(404).json({ error: 'Not found' });
        const u = accounts.authenticate(bearer(req));
        if (!u) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED' });
        const rl = limiters.loginIp.hit(ipOf(req));
        if (!rl.ok) return limited(res, rl);
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const r = await accounts.rename(u.id, b.name);
        if (!r.ok) return res.status(r.code === 'SERVER_ERROR' ? 503 : (r.code === 'NAME_TAKEN' ? 409 : (r.code === 'RENAME_WAIT' ? 429 : 400))).json({ ok: false, code: r.code, message: r.message, ...(r.wait ? { wait: r.wait } : {}) });
        if (r.changed) {
            const name = r.user.name;
            await Promise.all([
                dms && dms.renameOwner(r.oldKey, nameKey(name), name),
                listings && listings.renameOwner(u.id, name),
                requests && requests.renameOwner(u.id, name),
                reviews && reviews.renameAuthor(u.id, name),
                services && services.renameOwner(u.id, name),
                dviz && dviz.renameOwner(u.id, name),
                store && store.renameUser(r.oldName, name)
            ].filter(Boolean));
            // открытые сессии этого человека получают новое имя сразу
            if (io) io.to('user:' + u.id).emit('account-renamed', { id: u.id, name });
        }
        res.json({ ok: true, user: r.user });
    }

    function me(req, res) {
        if (!accounts) return res.status(404).json({ error: 'Not found' });
        const u = accounts.authenticate(bearer(req));
        if (!u) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED' });
        res.json({ ok: true, user: { id: u.id, name: u.name, verified: !!u.verified, verifs: u.verifs, avatar: accounts.avatarOf(u.id) } });
    }

    // Аватарки по именам: чтобы везде, где виден человек (чаты, комментарии, карточки), рядом была его картинка
    function avatarsByNames(req, res) {
        if (!accounts) return res.status(404).json({ error: 'Not found' });
        const names = String(req.query.names || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 40);
        res.set('Cache-Control', 'private, max-age=60');
        res.json({ ok: true, avatars: accounts.avatarsByNames(names) });
    }

    // Аватарка из готового набора: её видят другие в карточках запросов
    async function setAvatar(req, res) {
        if (!accounts) return res.status(404).json({ error: 'Not found' });
        const u = accounts.authenticate(bearer(req));
        if (!u) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED' });
        const rl = limiters.loginIp.hit(ipOf(req));
        if (!rl.ok) return limited(res, rl);
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const r = await accounts.setAvatar(u.id, b.avatar);
        if (!r.ok) return res.status(r.code === 'SERVER_ERROR' ? 503 : 400).json({ ok: false, code: r.code, message: r.message });
        res.json({ ok: true, avatar: r.avatar });
    }

    // ---------- push-уведомления ----------
    function pushKey(req, res) {
        res.json({ ok: true, enabled: !!(push && push.enabled()), key: push && push.enabled() ? push.publicKey() : '' });
    }

    async function pushSubscribe(req, res) {
        if (!accounts || !pushStore || !push || !push.enabled()) return res.status(404).json({ error: 'Not found' });
        const u = accounts.authenticate(bearer(req));
        if (!u) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED' });
        const rl = limiters.pushSub.hit(u.id);
        if (!rl.ok) return limited(res, rl);
        const r = await pushStore.add(u.id, req.body && req.body.subscription);
        if (!r.ok) return res.status(r.code === 'STORE_UNAVAILABLE' ? 503 : 400).json({ ok: false, code: r.code });
        res.json({ ok: true });
    }

    async function pushUnsubscribe(req, res) {
        if (!accounts || !pushStore) return res.status(404).json({ error: 'Not found' });
        const u = accounts.authenticate(bearer(req));
        if (!u) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED' });
        const ep = req.body && typeof req.body.endpoint === 'string' ? req.body.endpoint : '';
        await pushStore.removeEndpoint(ep, u.id);
        res.json({ ok: true });
    }

    // ---------- проверка хозяев ----------
    async function verifyRequest(req, res) {
        if (!accounts) return res.status(404).json({ error: 'Not found' });
        const u = accounts.authenticate(bearer(req));
        if (!u) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED' });
        const rl = limiters.verifyRequest.hit(u.id);
        if (!rl.ok) return limited(res, rl);
        const note = req.body && typeof req.body.note === 'string' ? req.body.note : '';
        const r = await accounts.requestVerification(u.id, note);
        if (!r.ok) return res.status(r.code === 'AUTH_REQUIRED' ? 401 : 503).json({ ok: false, code: r.code });
        res.json({ ok: true, already: !!r.already });
    }

    async function adminVerify(req, res) {
        if (!accounts) return res.status(404).json({ error: 'Not found' });
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        if (!(await requireAdmin(req, res, 'verify', { target: String(b.name || '').slice(0, 40) }))) return;
        if (typeof b.name !== 'string' || typeof b.verified !== 'boolean') {
            return res.status(400).json({ ok: false, code: 'BAD_PAYLOAD', message: 'Нужны name и verified (true/false)' });
        }
        const kind = b.kind === undefined ? 'housing' : b.kind;
        if (kind !== 'housing' && kind !== 'trips' && kind !== 'services') return res.status(400).json({ ok: false, code: 'BAD_PAYLOAD', message: 'kind: housing, trips или services' });
        const ok = await accounts.setVerified(nameKey(b.name), b.verified, kind);
        if (!ok) return res.status(404).json({ ok: false, code: 'NO_USER' });
        await admin.audit('verify', { target: b.name.slice(0, 40), verified: b.verified, kind, ip: ipOf(req) });
        const who = accounts.findByKey(nameKey(b.name));
        const KIND_TITLE = { housing: 'Вы проверенный хозяин', trips: 'Вы проверенный водитель', services: 'Ваши развлечения проверены' };
        if (notifier && who && b.verified) notifier.notify([who.id], { kind: 'verify', title: KIND_TITLE[kind], body: 'Рядом с вашими публикациями появится значок «Проверен»: вам будут больше доверять', open: 'profile', tag: 'verify-' + kind });
        res.json({ ok: true });
    }

    async function adminVerifyRequests(req, res) {
        if (!accounts) return res.status(404).json({ error: 'Not found' });
        if (!(await requireAdmin(req, res, 'verify_requests', {}))) return;
        res.json({ ok: true, requests: accounts.listVerifyRequests() });
    }

    // ---------- модерация (панель /admin) ----------
    const trunc = (v, n) => String(v == null ? '' : v).slice(0, n);

    async function adminOverview(req, res) {
        if (!(await requireAdmin(req, res, 'overview', {}))) return;
        res.json({ ok: true, rooms: store.stats().rooms, users: accounts ? accounts.stats() : null,
                   listings: listings ? listings.listAll().length : 0 });
    }

    async function adminMessages(req, res) {
        if (!(await requireAdmin(req, res, 'view_messages', { room: trunc(req.params.room, 20) }))) return;
        if (!isValidRoom(req.params.room, cfg.rooms)) return res.status(404).json({ error: 'Комната не найдена' });
        const limit = Math.min(Math.max(parseInt(req.query && req.query.limit, 10) || 100, 1), 200);
        const h = store.getHistory(req.params.room, { limit, before: (req.query && req.query.before) || null });
        res.json({ ok: true, ...h });
    }

    async function adminDeleteMessage(req, res) {
        const { room, id } = req.params;
        if (!(await requireAdmin(req, res, 'delete_message', { room: trunc(room, 20), id: trunc(id, 80) }))) return;
        if (!isValidRoom(room, cfg.rooms)) return res.status(404).json({ error: 'Комната не найдена' });
        try {
            const m = store.findMessage(room, id);
            const author = m ? trunc(m.user, 40) : '';
            const ok = await store.removeMessage(room, id);
            if (!ok) return res.status(404).json({ ok: false, code: 'MESSAGE_NOT_FOUND' });
            await admin.audit('delete_message', { room, id: trunc(id, 80), author, ip: ipOf(req) });
            io.to(room).emit('message-deleted', { room, id });
            res.json({ ok: true });
        } catch (e) {
            logger.error?.(`adminDeleteMessage: ${e.code || e.message}`);
            res.status(503).json({ ok: false, code: 'STORE_UNAVAILABLE' });
        }
    }

    async function adminPurgeUser(req, res) {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        if (!(await requireAdmin(req, res, 'purge_user', { target: trunc(b.name, 40) }))) return;
        if (typeof b.name !== 'string' || !b.name.trim()) return res.status(400).json({ ok: false, code: 'BAD_PAYLOAD', message: 'Нужно имя' });
        try {
            const removed = await store.removeByUser(b.name);
            for (const r of removed.slice(0, 2000)) io.to(r.room).emit('message-deleted', r);
            await admin.audit('purge_user', { target: trunc(b.name, 40), removed: removed.length, ip: ipOf(req) });
            res.json({ ok: true, removed: removed.length });
        } catch (e) {
            logger.error?.(`adminPurgeUser: ${e.code || e.message}`);
            res.status(503).json({ ok: false, code: 'STORE_UNAVAILABLE' });
        }
    }

    async function adminUsers(req, res) {
        if (!accounts) return res.status(404).json({ error: 'Not found' });
        if (!(await requireAdmin(req, res, 'view_users', {}))) return;
        res.json({ ok: true, users: accounts.listUsers(req.query && req.query.q) });
    }

    async function adminBan(req, res) {
        if (!accounts) return res.status(404).json({ error: 'Not found' });
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        if (!(await requireAdmin(req, res, 'ban', { target: trunc(b.name, 40) }))) return;
        if (typeof b.name !== 'string' || typeof b.banned !== 'boolean') return res.status(400).json({ ok: false, code: 'BAD_PAYLOAD', message: 'Нужны name и banned (true/false)' });
        const u = accounts.findByKey(nameKey(b.name));
        if (!u) return res.status(404).json({ ok: false, code: 'NO_USER' });
        if (!(await accounts.setBanned(nameKey(b.name), b.banned))) return res.status(503).json({ ok: false, code: 'STORE_UNAVAILABLE' });
        if (b.banned && io && typeof io.in === 'function') { try { io.in('user:' + u.id).disconnectSockets(true); } catch (e) { /* не критично */ } }
        await admin.audit('ban', { target: trunc(b.name, 40), banned: b.banned, ip: ipOf(req) });
        res.json({ ok: true });
    }

    async function adminVerifyReject(req, res) {
        if (!accounts) return res.status(404).json({ error: 'Not found' });
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        if (!(await requireAdmin(req, res, 'verify_reject', { target: trunc(b.name, 40) }))) return;
        if (typeof b.name !== 'string') return res.status(400).json({ ok: false, code: 'BAD_PAYLOAD' });
        if (!(await accounts.rejectVerification(nameKey(b.name)))) return res.status(404).json({ ok: false, code: 'NO_REQUEST' });
        await admin.audit('verify_reject', { target: trunc(b.name, 40), ip: ipOf(req) });
        res.json({ ok: true });
    }

    async function adminReports(req, res) {
        if (!dms) return res.status(404).json({ error: 'Not found' });
        if (!(await requireAdmin(req, res, 'view_reports', {}))) return;
        res.json({ ok: true, reports: dms.reportsList({ status: req.query && req.query.status === 'all' ? 'all' : 'open' }) });
    }

    async function adminReportClose(req, res) {
        if (!dms) return res.status(404).json({ error: 'Not found' });
        if (!(await requireAdmin(req, res, 'close_report', { id: trunc(req.params.id, 40) }))) return;
        const r = await dms.closeReport(req.params.id);
        if (!r.ok) return res.status(r.code === 'REPORT_NOT_FOUND' ? 404 : 503).json({ ok: false, code: r.code });
        await admin.audit('close_report', { id: trunc(req.params.id, 40), ip: ipOf(req) });
        res.json({ ok: true });
    }

    async function adminListings(req, res) {
        if (!listings) return res.status(404).json({ error: 'Not found' });
        if (!(await requireAdmin(req, res, 'view_listings', {}))) return;
        res.json({ ok: true, listings: listings.listAll() });
    }

    async function adminDeleteListing(req, res) {
        if (!listings) return res.status(404).json({ error: 'Not found' });
        if (!(await requireAdmin(req, res, 'delete_listing', { id: trunc(req.params.id, 40) }))) return;
        const r = await listings.removeAny(req.params.id);
        if (!r.ok) return res.status(r.code === 'LISTING_NOT_FOUND' ? 404 : 503).json({ ok: false, code: r.code });
        if (reviews) await reviews.dropListing(req.params.id);
        if (notifier && r.ownerId) notifier.notify([r.ownerId], { kind: 'listing', title: 'Объявление удалено', body: 'Модератор удалил ваше объявление «' + trunc(r.title, 60) + '»', open: 'profile', tag: 'listing-removed' });
        await admin.audit('delete_listing', { id: trunc(req.params.id, 40), owner: trunc(r.ownerName, 40), ip: ipOf(req) });
        if (io && typeof io.emit === 'function') io.emit('listing-changed', { id: req.params.id, removed: true });
        res.json({ ok: true });
    }

    async function adminRequests(req, res) {
        if (!requests) return res.status(404).json({ error: 'Not found' });
        if (!(await requireAdmin(req, res, 'view_requests', {}))) return;
        res.json({ ok: true, requests: requests.listAll() });
    }

    async function adminDeleteRequest(req, res) {
        if (!requests) return res.status(404).json({ error: 'Not found' });
        if (!(await requireAdmin(req, res, 'delete_request', { id: trunc(req.params.id, 40) }))) return;
        const before = photosOf(req.params.id);
        const r = await requests.removeAny(req.params.id);
        if (!r.ok) return res.status(r.code === 'REQUEST_NOT_FOUND' ? 404 : 503).json({ ok: false, code: r.code });
        dropPhotos(before);
        if (notifier && r.ownerId) notifier.notify([r.ownerId], { kind: 'request', title: 'Запрос удалён', body: 'Модератор удалил ваш запрос' + (r.title ? ' «' + trunc(r.title, 60) + '»' : ''), open: 'profile', tag: 'request-removed' });
        await admin.audit('delete_request', { id: trunc(req.params.id, 40), owner: trunc(r.ownerName, 40), title: trunc(r.title, 60), ip: ipOf(req) });
        if (io && typeof io.emit === 'function') io.emit('request-changed', { id: req.params.id, removed: true });
        res.json({ ok: true });
    }

    // Вход «глазами пользователя» (режим поддержки): короткая сессия без доступа к личной переписке
    async function adminImpersonate(req, res) {
        if (!accounts) return res.status(404).json({ error: 'Not found' });
        if (!(await requireAdmin(req, res, 'impersonate', {}))) return;
        const b = req.body || {};
        if (typeof b.name !== 'string' || !b.name.trim()) return res.status(400).json({ ok: false, code: 'BAD_REQUEST' });
        const u = accounts.findByKey(nameKey(b.name));
        if (!u) return res.status(404).json({ ok: false, code: 'NO_USER' });
        const s = await accounts.startSupport(u.key);
        if (!s) return res.status(503).json({ ok: false, code: 'SERVER_ERROR' });
        await admin.audit('impersonate', { target: trunc(u.name, 40), ip: ipOf(req) });
        res.json({ ok: true, token: s.token, user: { id: s.user.id, name: s.user.name, verified: !!s.user.verified }, expires: s.expires });
    }


    // ---------- удаление аккаунта: пароль + каскад по всем хранилищам ----------
    // Порядок важен: сначала всё содержимое, аккаунт — последним. Если что-то упало, аккаунт остаётся и удаление можно повторить.
    async function accountDelete(req, res) {
        if (!accounts) return res.status(404).json({ error: 'Not found' });
        const u = accounts.authenticate(bearer(req));
        if (!u) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED' });
        const rl = limiters.accountDelete.hit(u.id);
        if (!rl.ok) return limited(res, rl);
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        if (!(await accounts.checkPassword(u.id, b.password))) return res.status(401).json({ ok: false, code: 'BAD_CREDENTIALS', message: 'Пароль не подходит' });
        const done = {};
        try {
            if (store) { const removed = await store.removeByUser(u.name); done.messages = removed.length; if (io) for (const r of removed.slice(0, 2000)) io.to(r.room).emit('message-deleted', r); }
            const steps = [
                ['listings', () => listings && listings.eraseUser(u.id)],
                ['requests', () => requests && requests.eraseUser(u.id)],
                ['dviz', () => dviz && dviz.eraseUser(u.id)],
                ['services', () => services && services.eraseUser(u.id)],
                ['reviews', () => reviews && reviews.eraseUser(u.id)],
                ['favorites', () => favorites && favorites.eraseUser(u.id)],
                ['searches', () => searches && searches.eraseUser(u.id)],
                ['inbox', () => inbox && inbox.eraseUser(u.id)],
                ['push', () => pushStore && pushStore.eraseUser(u.id)],
                ['invites', () => invites && invites.eraseUser(u.id)],
                ['media', () => media && media.eraseUser(u.id)],
                ['dms', () => dms && dms.eraseUser(u)],
                ['groups', () => groups && groups.eraseUser(u.id)],
                ['reactions', () => adReacts && adReacts.eraseUser(u.id)],
                ['reports', () => reports && reports.eraseUser(u.id)]
            ];
            for (const [name, fn] of steps) { const r = fn(); if (r) done[name] = await r; }
            const r = await accounts.removeUser(u.id);
            if (!r.ok) throw new Error(r.code || 'ACCOUNT_STORE');
        } catch (e) {
            logger.error?.(`accountDelete ${u.id}: ${(e && (e.code || e.message)) || e}`);
            return res.status(503).json({ ok: false, code: 'ERASE_FAILED', message: 'Не удалось удалить все данные. Попробуйте ещё раз: аккаунт пока не удалён' });
        }
        if (io && typeof io.in === 'function') { try { io.in('user:' + u.id).disconnectSockets(true); } catch (e) { /* не критично */ } }
        logger.info?.(`Аккаунт удалён пользователем: ${u.id}`);
        res.json({ ok: true });
    }

    // ---------- смена пароля ----------
    async function passwordChange(req, res) {
        if (!accounts) return res.status(404).json({ error: 'Not found' });
        const token = bearer(req);
        const u = accounts.authenticate(token);
        if (!u) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED' });
        const rl = limiters.passwordChange.hit(u.id);
        if (!rl.ok) return limited(res, rl);
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const r = await accounts.changePassword(u.id, b.oldPassword, b.newPassword, token);
        if (!r.ok) {
            if (r.code === 'BAD_CREDENTIALS') return res.status(401).json({ ok: false, code: r.code, message: 'Текущий пароль не подходит' });
            return res.status(r.code === 'BAD_PASSWORD' || r.code === 'SAME_PASSWORD' ? 400 : 503).json(r);
        }
        if (io && typeof io.in === 'function') { try { io.in('user:' + u.id).disconnectSockets(true); } catch (e) { /* не критично */ } }
        logger.info?.(`Пароль изменён: ${u.id}`);
        mailNotice(accounts.emailOf(u.id), 'Пароль изменён', 'Пароль вашего аккаунта в YuGi YuGi был изменён. Все остальные устройства вышли из аккаунта.\n\nЕсли это были не вы, сразу восстановите доступ через «Забыли пароль?» на экране входа.');
        res.json({ ok: true });
    }

    // ---------- восстановление доступа: код восстановления, почта, «забыли пароль» ----------
    const mail = mailer || { enabled: false, send: async () => { throw new Error('MAIL_DISABLED'); } };
    const mailBudget = () => limiters.mailGlobal.hit('all').ok;
    // письма-уведомления: без ожидания и без ошибок наружу
    function mailNotice(to, subject, text) {
        if (!to || !mail.enabled || !mailBudget()) return;
        mail.send({ to, subject: subject + ' — YuGi YuGi', text: text + '\n\nYuGi YuGi · yugiyugi.ru' }).catch(() => {});
    }
    function authUser(req, res) {
        if (!accounts) { res.status(404).json({ error: 'Not found' }); return null; }
        const u = accounts.authenticate(bearer(req));
        if (!u) { res.status(401).json({ ok: false, code: 'AUTH_REQUIRED' }); return null; }
        return u;
    }
    const recFail = (res, r) => res.status({ BAD_CREDENTIALS: 401, EMAIL_TAKEN: 409, MAIL_WAIT: 429, RESET_LOCKED: 429, SERVER_ERROR: 503 }[r.code] || 400)
        .json({ ok: false, code: r.code, message: r.code === 'BAD_CREDENTIALS' ? 'Пароль не подходит' : r.message });
    const bodyOf = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

    function authOptions(req, res) { res.json({ ok: true, mail: mail.enabled }); }

    function recoveryInfo(req, res) {
        const u = authUser(req, res); if (!u) return;
        res.json({ ...accounts.recoveryStatus(u.id), mail: mail.enabled });
    }

    async function recoveryCodeNew(req, res) {
        const u = authUser(req, res); if (!u) return;
        const rl = limiters.passwordChange.hit(u.id);
        if (!rl.ok) return limited(res, rl);
        const r = await accounts.newRecoveryCode(u.id, bodyOf(req).password);
        if (!r.ok) return recFail(res, r);
        logger.info?.(`Новый код восстановления: ${u.id}`);
        res.json({ ok: true, code: r.code });
    }

    async function emailStart(req, res) {
        const u = authUser(req, res); if (!u) return;
        if (!mail.enabled) return res.status(503).json(fail('MAIL_DISABLED'));
        const rl = limiters.emailAdd.hit(u.id);
        if (!rl.ok) return limited(res, rl);
        const b = bodyOf(req);
        const r = await accounts.emailStart(u.id, b.password, b.email);
        if (!r.ok) return recFail(res, r);
        if (r.already) return res.json({ ok: true, already: true });
        if (!mailBudget()) { accounts.emailCancel(u.id); return res.status(503).json(fail('MAIL_LIMIT')); }
        try {
            await mail.send({ to: r.email, subject: 'Код подтверждения почты — YuGi YuGi', text: `Ваш код: ${r.code}\n\nВведите его в приложении, чтобы привязать эту почту к аккаунту. Код действует 15 минут.\n\nЕсли вы не запрашивали привязку, просто проигнорируйте письмо.\n\nYuGi YuGi · yugiyugi.ru` });
        } catch (e) { accounts.emailCancel(u.id); return res.status(502).json(fail('MAIL_FAILED')); }
        res.json({ ok: true });
    }

    async function emailConfirm(req, res) {
        const u = authUser(req, res); if (!u) return;
        const rl = limiters.emailAdd.hit(u.id + ':c');
        if (!rl.ok) return limited(res, rl);
        const r = await accounts.emailConfirm(u.id, bodyOf(req).code);
        if (!r.ok) return recFail(res, r);
        res.json({ ok: true, email: r.email });
    }

    async function emailRemove(req, res) {
        const u = authUser(req, res); if (!u) return;
        const rl = limiters.passwordChange.hit(u.id);
        if (!rl.ok) return limited(res, rl);
        const r = await accounts.emailRemove(u.id, bodyOf(req).password);
        if (!r.ok) return recFail(res, r);
        res.json({ ok: true });
    }

    // «Забыли пароль», шаг 1: ответ всегда одинаковый, есть у аккаунта почта или нет
    async function resetStart(req, res) {
        if (!accounts) return res.status(404).json({ error: 'Not found' });
        if (!mail.enabled) return res.status(503).json(fail('MAIL_DISABLED'));
        const rl = limiters.resetIp.hit(ipOf(req));
        if (!rl.ok) return limited(res, rl);
        const b = bodyOf(req);
        if (typeof b.name === 'string') { const rn = limiters.resetName.hit(nameKey(b.name).slice(0, 40)); if (!rn.ok) return limited(res, rn); }
        const r = accounts.resetStart(b.name);
        if (r.code && mailBudget()) {
            mail.send({ to: r.email, subject: 'Восстановление пароля — YuGi YuGi', text: `Код для сброса пароля: ${r.code}\n\nВведите его в приложении вместе с новым паролем. Код действует 15 минут.\n\nЕсли вы не запрашивали сброс, ничего не делайте: пароль останется прежним.\n\nYuGi YuGi · yugiyugi.ru` }).catch(() => {});
        }
        res.json({ ok: true });
    }

    // Шаг 2: новый пароль по коду из письма или по коду восстановления; сразу входим
    async function resetConfirm(req, res) {
        if (!accounts) return res.status(404).json({ error: 'Not found' });
        const rl = limiters.resetIp.hit(ipOf(req));
        if (!rl.ok) return limited(res, rl);
        const b = bodyOf(req);
        if (b.method !== 'email' && b.method !== 'recovery') return res.status(400).json(fail('RESET_FAILED'));
        if (typeof b.name === 'string') { const rn = limiters.resetName.hit(nameKey(b.name).slice(0, 40)); if (!rn.ok) return limited(res, rn); }
        const r = await accounts.resetConfirm(b.name, b.method, b.code, b.password);
        if (!r.ok) return recFail(res, r);
        if (io && typeof io.in === 'function') { try { io.in('user:' + r.user.id).disconnectSockets(true); } catch (e) { /* не критично */ } }
        logger.info?.(`Пароль сброшен по ${b.method}: ${r.user.id}`);
        mailNotice(r.email, 'Пароль изменён', 'Пароль вашего аккаунта в YuGi YuGi был сброшен по коду восстановления, все устройства вышли из аккаунта.\n\nЕсли это были не вы, срочно напишите в поддержку.');
        res.json({ ok: true, token: r.token, user: r.user, ...(r.recoveryCode ? { recoveryCode: r.recoveryCode } : {}) });
    }

    // ---------- жалобы на контент и блокировка пользователей ----------
    function reportTarget(kind, id, room) {
        const ownerOf = (ownerId, ownerName, title) => ({ ownerId: ownerId || '', ownerName: ownerName || '', title: title || '' });
        if (kind === 'listing') { const l = listings && listings.rawById(id); return l ? ownerOf(l.ownerId, l.ownerName, l.ad && l.ad.title) : null; }
        if (kind === 'request') { const r = requests && requests.data.requests[id]; return r ? ownerOf(r.ownerId, r.ownerName, r.title || r.text) : null; }
        if (kind === 'dviz') { const e = dviz && dviz.data.items[id]; return e ? ownerOf(e.ownerId, e.ownerName, e.title) : null; }
        if (kind === 'service') { const s = services && services.data.items[id]; return s ? ownerOf(s.ownerId, s.ownerName, s.title) : null; }
        if (kind === 'review') { const r = reviews && reviews.get(id); return r ? ownerOf(r.authorId, r.authorName, r.text) : null; }
        if (kind === 'user') { const x = accounts && accounts.byId(id); return x ? ownerOf(x.id, x.name, x.name) : null; }
        if (kind === 'message') {
            const list = store && typeof room === 'string' && Array.isArray(store.data[room]) ? store.data[room] : [];
            const m = list.find(x => x && x.id === id);
            if (!m) return null;
            const o = accounts && accounts.findByKey(nameKey(m.user || ''));
            return ownerOf(o ? o.id : '', m.user, String(m.text || '').slice(0, 160));
        }
        return null;
    }

    async function reportCreate(req, res) {
        if (!accounts || !reports) return res.status(404).json({ error: 'Not found' });
        const u = accounts.authenticate(bearer(req));
        if (!u) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', message: 'Войдите в аккаунт, чтобы пожаловаться' });
        const rl = limiters.reportWrite.hit(u.id);
        if (!rl.ok) return limited(res, rl);
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const target = reportTarget(b.kind, typeof b.targetId === 'string' ? b.targetId : '', b.room);
        if (!target) return res.status(404).json({ ok: false, code: 'TARGET_NOT_FOUND', message: 'Материал уже удалён или не найден' });
        const created = accounts.data && accounts.data.users && accounts.data.users[u.id] && accounts.data.users[u.id].createdAt;
        const trusted = !created || ((typeof accounts.now === 'function' ? accounts.now() : Date.now()) - created) >= 24 * 3600 * 1000;
        const r = await reports.create(u, b, target, { trusted });
        if (!r.ok) return res.status(r.code === 'STORE_UNAVAILABLE' ? 503 : (r.code === 'REPORT_DUPLICATE' ? 409 : 400)).json(r);
        res.status(201).json({ ok: true, id: r.id });
    }

    async function blocksList(req, res) {
        if (!accounts || !dms) return res.status(404).json({ error: 'Not found' });
        const u = accounts.authenticate(bearer(req));
        if (!u) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED' });
        const users = dms.blockedIds(u.id).map(id => { const x = accounts.byId(id); return x ? { id: x.id, name: x.name } : null; }).filter(Boolean);
        res.json({ ok: true, users });
    }

    async function blockSet(req, res) {
        if (!accounts || !dms) return res.status(404).json({ error: 'Not found' });
        const u = accounts.authenticate(bearer(req));
        if (!u) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED' });
        const rl = limiters.blockWrite.hit(u.id);
        if (!rl.ok) return limited(res, rl);
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const r = await dms.blockUser(u, b.userId, b.on !== false);
        if (!r.ok) return res.status(r.code === 'STORE_UNAVAILABLE' ? 503 : (r.code === 'NO_USER' ? 404 : 400)).json(r);
        res.json({ ok: true, users: r.blocked.map(id => { const x = accounts.byId(id); return x ? { id: x.id, name: x.name } : null; }).filter(Boolean) });
    }

    async function adminContentReports(req, res) {
        if (!reports) return res.status(404).json({ error: 'Not found' });
        if (!(await requireAdmin(req, res, 'view_content_reports', {}))) return;
        const list = reports.list({ status: req.query && req.query.status === 'all' ? 'all' : 'open' }).map(r => ({ ...r, openCount: reports.openCount(r.kind, r.targetId), hidden: reports.isHidden(r.kind, r.targetId) }));
        res.json({ ok: true, reports: list });
    }

    async function adminContentReportClose(req, res) {
        if (!reports) return res.status(404).json({ error: 'Not found' });
        if (!(await requireAdmin(req, res, 'close_content_report', { id: trunc(req.params.id, 40) }))) return;
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const r = await reports.close(req.params.id, b.note);
        if (!r.ok) return res.status(r.code === 'REPORT_NOT_FOUND' ? 404 : 503).json({ ok: false, code: r.code });
        await admin.audit('close_content_report', { id: trunc(req.params.id, 40), ip: ipOf(req) });
        res.json({ ok: true });
    }

    // В режиме поддержки закрыто всё личное: переписка, уведомления, push, медиа, данные аккаунта.
    // Разрешено смотреть и править объявления, услуги и запросы.
    const SUPPORT_OK = /^\/(auth\/(me|logout)|profile|my\/stats|weather|favorites|searches|listings|services|dviz|requests|reviews)(\/|$)/;
    const SUPPORT_DENY = /^\/requests\/(matching|[^/]+\/(offers|matches))(\/|$)/;
    async function supportGuard(req, res, next) {
        const t = bearer(req);
        if (t && accounts && accounts.isSupport(t) && !(SUPPORT_OK.test(req.path) && !SUPPORT_DENY.test(req.path))) {
            return res.status(403).json({ ok: false, code: 'SUPPORT_MODE' });
        }
        next();
    }

    async function adminAudit(req, res) {
        if (!(await requireAdmin(req, res, 'view_audit', {}))) return;
        res.json({ ok: true, entries: await admin.readAudit(parseInt(req.query && req.query.limit, 10) || 100) });
    }

    // ---------- страница панели ----------
    const PANEL = require('./adminPage');
    function panel(kind) {
        return (req, res) => {
            if (!admin.isEnabled()) return res.status(404).json({ error: 'Not found' });
            res.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
            res.set('X-Frame-Options', 'DENY');
            res.set('Content-Type', PANEL[kind].type);
            res.send(PANEL[kind].body);
        };
    }

    // ---------- лимиты публикаций и приглашения друзей ----------
    const SECTION_TITLE = { housing: 'Жильё', work: 'Работа', trips: 'Поездки', services: 'Развлечения' };
    const sectionOf = (raw) => (['housing', 'work', 'trips', 'services'].includes(raw) ? raw : 'housing');
    function dailyLimit(res, q) {
        const more = q.limit < 5 ? '. Пригласите друга: за каждого, кто зарегистрируется и опубликует карточку, лимит растёт на одну в день' : '. Это максимум, новые можно завтра';
        return res.status(429).json({ ok: false, code: 'DAILY_LIMIT', message: `Сегодня в разделе «${SECTION_TITLE[q.section]}» вы уже опубликовали ${q.used} из ${q.limit}${more}`, quota: q });
    }
    // Друг опубликовал первую карточку: тому, кто пригласил, +1 к лимиту
    async function afterPublish(user) {
        if (!invites) return;
        try {
            const q = await invites.qualify(user.id);
            if (q && q.counted && notifier) notifier.notify([q.inviterId], { kind: 'invite', title: 'Друг опубликовал карточку', body: user.name + ': ваш лимит публикаций вырос на одну в день', open: 'profile', tag: 'inv-' + user.id });
        } catch (e) { logger.warn?.(`invites qualify: ${e && e.message}`); }
    }

    async function invitesMe(req, res) {
        if (!invites) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const code = await invites.ensureCode(user.id);
        if (!code) return res.status(503).json({ ok: false, code: 'STORE_UNAVAILABLE', message: 'Попробуйте позже' });
        const friends = invites.friendsOf(user.id);
        res.json({ ok: true, code, friends, counted: invites.bonus(user.id), maxFriends: 5, base: 1, cap: 5, limit: invites.limitFor(user.id), quotas: invites.allQuotas(user.id) });
    }

    // ---------- объявления ----------
    const listingFail = (res, r) => res.status(
        r.code === 'LISTING_NOT_FOUND' ? 404 : (r.code === 'NOT_OWNER' || r.code === 'NOT_VERIFIED') ? 403 :
        (r.code === 'STORE_UNAVAILABLE' || r.code === 'LISTINGS_FULL') ? 503 : (r.code === 'DAILY_LIMIT' || r.code === 'BUMP_WAIT') ? 429 : 400
    ).json({ ok: false, code: r.code, message: r.message, quota: r.quota, ...(r.wait ? { wait: r.wait } : {}) });

    // ---------- запросы арендаторов ----------
    const requestFail = (res, r) => res.status(
        (r.code === 'REQUEST_NOT_FOUND' || r.code === 'LISTING_NOT_FOUND') ? 404 : r.code === 'NOT_OWNER' ? 403 : r.code === 'REQUEST_WAIT' ? 429 :
        r.code === 'STORE_UNAVAILABLE' ? 503 : (r.code === 'REQUEST_DUPLICATE' || r.code === 'REQUEST_CLOSED' || r.code === 'OFFER_DUPLICATE' || r.code === 'OFFER_MISMATCH') ? 409 : 400
    ).json({ ok: false, code: r.code, message: r.message, wait: r.wait });
    const needUser = (req, res) => {
        const user = accounts && accounts.authenticate(bearer(req));
        if (!user) res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', message: 'Нужно войти в аккаунт' });
        return user || null;
    };

    // Аватарка и «в сети» владельца для карточек: online — открыто приложение, seen — когда последний раз был
    function withOwner(list) {
        if (!accounts) return list;
        const seen = {};
        list.forEach((r) => {
            if (!r.ownerId) return;
            if (!seen[r.ownerId]) seen[r.ownerId] = { avatar: accounts.avatarOf(r.ownerId), online: !!(notifier && notifier.isOnline && notifier.isOnline(r.ownerId)), seen: accounts.lastSeenOf(r.ownerId) };
            const o = seen[r.ownerId];
            r.ownerAvatar = o.avatar; r.ownerOnline = o.online; r.ownerSeen = o.seen;
        });
        return list;
    }

    // Автоскрытие по жалобам: скрытое видно только владельцу (и модератору в админке)
    function hideFor(kind, items, viewerId) {
        if (!reports || !items.length) return items;
        const hid = reports.hiddenIds(kind);
        if (!hid.size) return items;
        const me = viewerId === undefined ? null : viewerId;
        return items.filter(x => !hid.has(x.id) || (me && x.ownerId === me));
    }
    function hiddenFrom(kind, item, viewerId) {
        return !!(reports && item && reports.isHidden(kind, item.id) && !(viewerId && item.ownerId === viewerId));
    }

    function requestsList(req, res) {
        if (!requests) return res.status(404).json({ error: 'Not found' });
        const rl = limiters.history.hit(ipOf(req));
        if (!rl.ok) return limited(res, rl);
        const user = accounts && accounts.authenticate(bearer(req));
        const q = req.query || {};
        const mine = q.mine === '1';
        if (mine && !user) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', message: 'Нужно войти в аккаунт' });
        const status = ['active', 'found', 'closed', 'expired', 'all'].includes(q.status) ? q.status : 'active';
        const out = requests.list({ viewerId: user ? user.id : null, status, category: typeof q.category === 'string' ? q.category : '', section: ['housing', 'work', 'trips', 'services'].includes(q.section) ? q.section : '', kind: ['seek', 'offer'].includes(q.kind) ? q.kind : '', city: typeof q.city === 'string' ? q.city.slice(0, 60) : '', mine });
        // у своих активных запросов показываем, сколько вариантов найдено и сколько предложений пришло
        if (user && listings) out.forEach(r => { if (r.mine && r.status === 'active') { r.matchCount = requests.countMatches(requests.data.requests[r.id], listings); r.similarCount = requests.countSimilar(requests.data.requests[r.id], listings); r.offerCount = requests.offerCount(r.id); } });
        const shown = mine ? out : hideFor('request', out, user ? user.id : null);
        withOwner(shown);
        res.json({ ok: true, requests: shown, cooldown: user ? requests.cooldown(user.id) : 0 });
    }

    // Фото автомобиля: только свои загруженные снимки (id из /api/media), до 3 штук.
    // Файла уже нет (карточку публикуют заново спустя месяц) — просто пропускаем; чужой или не фото — отказ.
    function carPhotosOk(user, body) {
        const p = body && typeof body === 'object' ? body.photos : undefined;
        if (p === undefined) return true;
        if (!Array.isArray(p) || p.length > 3) return false;
        if (!p.length) return true;
        if (!media) return false;
        const keep = [];
        for (const id of p) {
            const it = media.info(id);
            if (!it) { if (typeof id === 'string' && /^vm_[0-9a-f]{32}$/.test(id)) continue; return false; }
            if (it.owner !== user.id || it.kind !== 'photo') return false;
            keep.push(id);
        }
        body.photos = keep;
        return true;
    }
    const dropPhotos = (ids) => { if (media && ids && ids.length) media.remove(ids).catch(() => {}); };
    const photosOf = (id) => { const r = requests && typeof id === 'string' ? requests.data.requests[id] : null; return r && Array.isArray(r.photos) ? r.photos.slice() : []; };

    async function requestCreate(req, res) {
        if (!requests) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.requestWrite.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        if (!carPhotosOk(user, req.body)) return res.status(400).json(fail('IMAGE_INVALID'));
        const hold = invites ? invites.reserve(user.id, sectionOf(req.body && req.body.section)) : null;
        if (hold && !hold.ok) return dailyLimit(res, hold.quota);
        const r = await requests.create(user, req.body);
        if (!r.ok) { if (hold) hold.undo(); return requestFail(res, r); }
        if (invites) { await invites.flush(); await afterPublish(user); }
        io.emit('request-changed', { id: r.request.id });
        const found = listings ? requests.countMatches(requests.data.requests[r.request.id], listings) : 0;
        const alike = listings ? requests.countSimilar(requests.data.requests[r.request.id], listings) : 0;
        res.json({ ok: true, request: r.request, cooldown: r.cooldown, matches: found, similar: alike });
    }

    function requestMatches(req, res) {
        if (!requests || !listings) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const r = requests.matchesFor(user, req.params.id, listings);
        if (!r.ok) return requestFail(res, r);
        res.json({ ok: true, listings: r.listings, similar: r.similar || [] });
    }

    function requestsMatching(req, res) {
        if (!requests || !listings) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        res.json({ ok: true, requests: requests.matchingFor(user, listings) });
    }

    async function requestOffer(req, res) {
        if (!requests || !listings) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.requestWrite.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const lid = req.body && typeof req.body.listingId === 'string' ? req.body.listingId : '';
        const r = await requests.offer(user, req.params.id, lid, listings);
        if (!r.ok) return requestFail(res, r);
        const l = listings.rawById(lid);
        if (notifier) notifier.notify([r.request.ownerId], { kind: 'offer', title: 'Вам предложили жильё', body: user.name + ': ' + trunc((l && l.ad.title) || 'жильё', 80), open: 'profile', tag: 'offer-' + r.request.id });
        io.emit('request-changed', { id: r.request.id });
        res.json({ ok: true });
    }

    function requestOffers(req, res) {
        if (!requests || !listings) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const r = requests.offersFor(user, req.params.id, listings);
        if (!r.ok) return requestFail(res, r);
        res.json({ ok: true, offers: r.offers });
    }

    async function requestOfferReject(req, res) {
        if (!requests) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.requestWrite.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const r = await requests.rejectOffer(user, req.params.id, req.params.oid);
        if (!r.ok) return requestFail(res, r);
        res.json({ ok: true });
    }

    async function requestEdit(req, res) {
        if (!requests) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.requestWrite.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        if (!carPhotosOk(user, req.body)) return res.status(400).json(fail('IMAGE_INVALID'));
        const before = photosOf(req.params.id);
        const r = await requests.edit(user, req.params.id, req.body);
        if (!r.ok) return requestFail(res, r);
        dropPhotos(before.filter((id) => !(r.request.photos || []).includes(id)));      // заменённые фото удаляем с диска
        io.emit('request-changed', { id: r.request.id });
        res.json({ ok: true, request: r.request });
    }

    // ---------- центр уведомлений ----------
    function inboxList(req, res) {
        if (!inbox) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.history.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        res.json({ ok: true, ...inbox.list(user.id), prefs: inbox.prefs(user.id) });
    }

    function inboxRead(req, res) {
        if (!inbox) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.requestWrite.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const sel = { all: b.all === true, ids: Array.isArray(b.ids) ? b.ids.filter(x => typeof x === 'string').slice(0, 100) : [], open: typeof b.open === 'string' ? b.open.slice(0, 120) : '' };
        res.json({ ok: true, ...inbox.markRead(user.id, sel) });
    }

    function inboxPrefs(req, res) {
        if (!inbox) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.requestWrite.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        if (!inbox.setPref(user.id, b.group, b.on === true)) return res.status(400).json({ ok: false, code: 'BAD_REQUEST', message: 'Неизвестный тип уведомлений' });
        res.json({ ok: true, prefs: inbox.prefs(user.id) });
    }

    // ---------- избранное ----------
    function favList(req, res) {
        if (!favorites || !listings) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.history.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        res.json({ ok: true, ids: favorites.ids(user.id), listings: favorites.list(user.id, listings) });
    }

    async function favSet(req, res) {
        if (!favorites || !listings) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.requestWrite.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const r = await favorites.set(user.id, b.id, b.on === true, listings);
        if (!r.ok) return res.status(r.code === 'LISTING_NOT_FOUND' ? 404 : r.code === 'STORE_UNAVAILABLE' ? 503 : 400).json({ ok: false, code: r.code, message: r.message });
        res.json({ ok: true, ids: r.ids });
    }

    async function requestNotify(req, res) {
        if (!requests) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.requestWrite.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const r = await requests.setNotify(user, req.params.id, !!(req.body && req.body.on));
        if (!r.ok) return requestFail(res, r);
        res.json({ ok: true, request: r.request });
    }

    async function requestStatus(req, res) {
        if (!requests) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.requestWrite.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const r = await requests.setStatus(user, req.params.id, req.body && req.body.status);
        if (!r.ok) return requestFail(res, r);
        io.emit('request-changed', { id: r.request.id });
        res.json({ ok: true, request: r.request });
    }

    async function requestDelete(req, res) {
        if (!requests) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.requestWrite.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const before = photosOf(req.params.id);
        const r = await requests.remove(user, req.params.id);
        if (!r.ok) return requestFail(res, r);
        dropPhotos(before);
        io.emit('request-changed', { id: req.params.id });
        res.json({ ok: true });
    }

    function listingsList(req, res) {
        if (!listings) return res.status(404).json({ error: 'Not found' });
        const r = limiters.history.hit(ipOf(req));
        if (!r.ok) return limited(res, r);
        res.json({ ok: true, listings: hideFor('listing', listings.list(), reports && reports.hiddenIds('listing').size ? viewerOf(req) : null) });
    }

    function listingGet(req, res) {
        if (!listings) return res.status(404).json({ error: 'Not found' });
        const r = limiters.history.hit(ipOf(req));
        if (!r.ok) return limited(res, r);
        const l = listings.get(req.params.id);
        if (!l || hiddenFrom('listing', l, reports && reports.isHidden('listing', l.id) ? viewerOf(req) : null)) return res.status(404).json({ ok: false, code: 'LISTING_NOT_FOUND' });
        if (stats) {
            const viewer = accounts && accounts.authenticate(bearer(req));
            if (!viewer || viewer.id !== l.ownerId) stats.view(l.id, viewer ? viewer.id : 'ip:' + ipOf(req));
        }
        res.json({ ok: true, listing: l });
    }

    async function listingSave(req, res) {
        if (!listings) return res.status(404).json({ error: 'Not found' });
        const user = accounts && accounts.authenticate(bearer(req));
        if (!user) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', message: 'Нужно войти в аккаунт' });
        const rl = limiters.listingSave.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const isNewAd = !(req.body && typeof req.body.id === 'string' && req.body.id);
        const hold = invites && isNewAd ? invites.reserve(user.id, 'housing') : null;
        if (hold && !hold.ok) return dailyLimit(res, hold.quota);
        const r = await listings.save(user, req.body);
        if (!r.ok) { if (hold) hold.undo(); return listingFail(res, r); }
        if (invites && r.created) { await invites.flush(); await afterPublish(user); }
        io.emit('listing-changed', { id: r.listing.id });
        res.json({ ok: true, listing: r.listing, quota: invites ? invites.quota(user.id, 'housing') : r.quota });
        // подписчикам на поиск: только о новых объявлениях
        if (searches && notifier && r.created) {
            const full = listings.get(r.listing.id);
            if (full) searches.notifyFor({ ...full, ownerId: r.listing.ownerId || listings.rawById(r.listing.id).ownerId }).then((list) => list.forEach((n) => {
                notifier.notify([n.userId], {
                    kind: 'search', title: n.count > 1 ? 'Новое жильё по ' + n.count + ' вашим поискам' : 'Новое по вашему поиску',
                    body: trunc(full.price, 30) + ' · ' + trunc(full.title, 80), open: 'listing:' + full.id, tag: 'search-' + n.searchId
                });
            })).catch(() => {});
        }
        // арендаторам, чей запрос подошёл под это жильё (новое или изменённое), уходит уведомление
        if (requests && notifier) {
            const raw = listings.rawById(r.listing.id);
            if (raw) requests.matchesNotify(raw).then((list) => list.forEach((n) => {
                notifier.notify([n.ownerId], {
                    kind: 'match',
                    title: n.count > 1 ? 'Найдено жильё под ' + n.count + ' ваших запроса' : 'Найдено жильё под ваш запрос',
                    body: trunc(raw.ad.price, 30) + ' · ' + trunc(raw.ad.title, 80), open: 'profile', tag: 'match-' + n.requests[0]
                });
                io.emit('request-changed', { id: n.requests[0] });
            })).catch(() => {});
        }
    }

    // «Сегодня опубликовано: 2 из 3»
    function listingQuota(req, res) {
        if (!listings) return res.status(404).json({ error: 'Not found' });
        const user = accounts && accounts.authenticate(bearer(req));
        if (!user) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', message: 'Нужно войти в аккаунт' });
        res.json({ ok: true, quota: invites ? invites.quota(user.id, 'housing') : listings.quota(user.id) });
    }

    async function listingDelete(req, res) {
        if (!listings) return res.status(404).json({ error: 'Not found' });
        const user = accounts && accounts.authenticate(bearer(req));
        if (!user) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', message: 'Нужно войти в аккаунт' });
        const rl = limiters.listingSave.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const r = await listings.remove(user, req.params.id);
        if (!r.ok) return listingFail(res, r);
        if (reviews) await reviews.dropListing(req.params.id);
        if (stats) stats.drop(req.params.id);
        io.emit('listing-changed', { id: req.params.id, removed: true });
        res.json({ ok: true });
    }

    // ---------- подписки на поиск ----------
    const searchFail = (res, r) => res.status(r.code === 'SEARCH_NOT_FOUND' ? 404 : r.code === 'STORE_UNAVAILABLE' ? 503 : 400).json({ ok: false, code: r.code, message: r.message });

    function searchesList(req, res) {
        if (!searches) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        res.json({ ok: true, searches: searches.list(user.id) });
    }
    async function searchAdd(req, res) {
        if (!searches) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.requestWrite.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const r = await searches.add(user.id, req.body);
        if (!r.ok) return searchFail(res, r);
        res.json({ ok: true, search: r.search, searches: r.searches });
    }
    async function searchRemove(req, res) {
        if (!searches) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.requestWrite.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const r = await searches.remove(user.id, req.params.id);
        if (!r.ok) return searchFail(res, r);
        res.json({ ok: true, searches: r.searches });
    }

    // ---------- отзывы ----------
    const reviewFail = (res, r) => res.status(
        r.code === 'REVIEW_NOT_FOUND' || r.code === 'LISTING_NOT_FOUND' ? 404 : r.code === 'STORE_UNAVAILABLE' ? 503 :
        (r.code === 'NOT_AUTHOR' || r.code === 'NOT_OWNER' || r.code === 'NEED_CONTACT' || r.code === 'SELF_REVIEW') ? 403 : r.code === 'ALREADY_REPLIED' ? 409 : 400
    ).json({ ok: false, code: r.code, message: r.message });

    function reviewsList(req, res) {
        if (!reviews || !listings) return res.status(404).json({ error: 'Not found' });
        const rl = limiters.history.hit(ipOf(req));
        if (!rl.ok) return limited(res, rl);
        const l = listings.rawById(req.params.id);
        if (!l) return reviewFail(res, { code: 'LISTING_NOT_FOUND' });
        const viewer = accounts && accounts.authenticate(bearer(req));
        res.json({ ok: true, ...reviews.list(l.id, viewer), status: reviews.status(viewer, l), isOwner: !!(viewer && viewer.id === l.ownerId) });
    }

    async function reviewSave(req, res) {
        if (!reviews || !listings) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.reviewWrite.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const l = listings.rawById(req.params.id);
        if (!l) return reviewFail(res, { code: 'LISTING_NOT_FOUND' });
        const r = await reviews.save(user, l, req.body);
        if (!r.ok) return reviewFail(res, r);
        if (notifier && r.created) notifier.notify([l.ownerId], { kind: 'review', title: 'Новый отзыв: ' + '★'.repeat(r.review.rating), body: user.name + ' об объявлении «' + trunc(l.ad && l.ad.title, 50) + '»', open: 'listing:' + l.id, tag: 'review:' + l.id });
        res.json({ ok: true, review: r.review, rating: r.rating, count: r.count });
    }

    async function reviewDelete(req, res) {
        if (!reviews) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.reviewWrite.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const r = await reviews.remove(user, req.params.id);
        if (!r.ok) return reviewFail(res, r);
        res.json({ ok: true });
    }

    async function reviewReply(req, res) {
        if (!reviews) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.reviewWrite.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const r = await reviews.reply(user, req.params.id, req.body && req.body.text);
        if (!r.ok) return reviewFail(res, r);
        const rv = r.review;
        if (notifier) notifier.notify([rv.authorId], { kind: 'review', title: 'Хозяин ответил на ваш отзыв', body: trunc(r.review.reply.text, 100), open: 'listing:' + rv.listingId, tag: 'review-reply:' + rv.id });
        res.json({ ok: true, reply: rv.reply });
    }

    // Кабинет хозяина: просмотры, избранное, диалоги, отзывы по каждому объявлению
    function myStats(req, res) {
        if (!listings) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.history.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const mine = listings.raws().filter(l => l.ownerId === user.id).sort((a, b) => b.updated - a.updated);
        const chatsBy = {}; let chatsAll = 0, chatsWeek = 0;
        if (dms) for (const c of Object.values(dms.data.convs)) {
            if (c.ownerKey !== user.key || !c.messages.length) continue;
            chatsAll++; if (c.created > Date.now() - 7 * 86400_000) chatsWeek++;
            if (c.adId) chatsBy[c.adId] = (chatsBy[c.adId] || 0) + 1;
        }
        let offers = 0;
        if (requests) for (const o of Object.values(requests.data.offers)) if (o.ownerId === user.id) offers++;
        const items = mine.map(l => {
            const s = stats ? stats.summary(l.id) : { total: 0, week: 0, series: [0, 0, 0, 0, 0, 0, 0] };
            const rs = reviews ? reviews.listingStats(l.id) : { rating: null, count: 0 };
            return { id: l.id, title: l.ad.title, price: l.ad.price, thumb: l.ad.thumb || '', views: s.total, views7: s.week, series: s.series,
                favorites: favorites ? favorites.countFor(l.id) : 0, chats: chatsBy[l.id] || 0, rating: rs.rating, reviews: rs.count };
        });
        const sum = (k) => items.reduce((a, i) => a + i[k], 0);
        const series = [0, 0, 0, 0, 0, 0, 0]; for (const i of items) i.series.forEach((v, n) => { series[n] += v; });
        res.json({ ok: true, totals: { views: sum('views'), views7: sum('views7'), favorites: sum('favorites'), chats: chatsAll, chatsWeek, offers, series }, listings: items });
    }

    // Публичный профиль человека: по id или по имени (в общих чатах известно только имя)
    function userProfile(req, res) {
        if (!accounts || !listings) return res.status(404).json({ error: 'Not found' });
        const r = limiters.history.hit(ipOf(req));
        if (!r.ok) return limited(res, r);
        const q = req.query || {};
        const u = typeof q.id === 'string' && q.id ? accounts.byId(q.id.slice(0, 40)) : (typeof q.name === 'string' && q.name ? accounts.findByKey(nameKey(q.name.slice(0, 60))) : null);
        if (!u) return res.status(404).json({ ok: false, code: 'USER_NOT_FOUND', message: 'Профиль не найден' });
        const viewer = accounts.authenticate(bearer(req));
        const raws = listings.raws().filter(l => l.ownerId === u.id).sort((a, b) => b.updated - a.updated);
        const rv = reviews ? reviews.forOwner(u.id, viewer, listings) : { items: [], rating: null, count: 0 };
        const full = accounts.data && accounts.data.users && accounts.data.users[u.id];
        res.json({
            ok: true, isMe: !!(viewer && viewer.id === u.id),
            user: { id: u.id, name: u.name, verified: !!u.verified, since: full && full.createdAt ? new Date(full.createdAt).getFullYear() : null, avatar: raws[0] ? raws[0].owner.avatar : '', about: raws[0] ? raws[0].owner.about : '' },
            listings: raws.map(l => listings.light(l)), services: services ? services.list({ ownerId: u.id }) : [], rating: rv.rating, count: rv.count, reviews: rv.items
        });
    }

    async function adminReviews(req, res) {
        if (!reviews) return res.status(404).json({ error: 'Not found' });
        if (!(await requireAdmin(req, res, 'view_reviews', {}))) return;
        res.json({ ok: true, reviews: reviews.listAll() });
    }

    async function adminReviewDelete(req, res) {
        if (!reviews) return res.status(404).json({ error: 'Not found' });
        if (!(await requireAdmin(req, res, 'delete_review', { id: trunc(req.params.id, 40) }))) return;
        const r = await reviews.remove(null, req.params.id, { admin: true });
        if (!r.ok) return reviewFail(res, r);
        await admin.audit('delete_review', { id: trunc(req.params.id, 40), author: trunc(r.review.authorName, 40), ip: ipOf(req) });
        res.json({ ok: true });
    }

    // ---------- погода в шапке ----------
    function weatherGet(req, res) {
        if (!weather) return res.status(404).json({ error: 'Not found' });
        res.set('Cache-Control', 'public, max-age=300');
        res.json({ ok: true, ...weather.current() });
    }
    async function adminWeatherGet(req, res) {
        if (!weather) return res.status(404).json({ error: 'Not found' });
        if (!(await requireAdmin(req, res, 'view_weather', {}))) return;
        res.json({ ok: true, ...weather.settings() });
    }
    async function adminWeatherSet(req, res) {
        if (!weather) return res.status(404).json({ error: 'Not found' });
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        if (!(await requireAdmin(req, res, 'set_weather', {}))) return;
        const r = await weather.update(b);
        if (!r.ok) return res.status(r.code === 'STORE_UNAVAILABLE' ? 503 : 400).json({ ok: false, code: r.code, message: r.message });
        await admin.audit('set_weather', {
            air: b.air ? { mode: trunc(b.air.mode, 8), manual: b.air.manual } : undefined,
            water: b.water ? { mode: trunc(b.water.mode, 8), manual: b.water.manual } : undefined, ip: ipOf(req)
        });
        res.json({ ok: true, ...weather.settings() });
    }
    async function adminWeatherRefresh(req, res) {
        if (!weather) return res.status(404).json({ error: 'Not found' });
        if (!(await requireAdmin(req, res, 'refresh_weather', {}))) return;
        await weather.refresh();
        res.json({ ok: true, ...weather.settings() });
    }

    // ---------- услуги в профиле ----------
    const serviceFail = (res, r) => res.status(
        r.code === 'SERVICE_NOT_FOUND' ? 404 : r.code === 'NOT_OWNER' ? 403 : r.code === 'STORE_UNAVAILABLE' || r.code === 'LISTINGS_FULL' ? 503 :
        r.code === 'BUMP_WAIT' ? 429 : 400
    ).json({ ok: false, code: r.code, message: r.message, ...(r.wait ? { wait: r.wait } : {}) });

    function servicesList(req, res) {
        if (!services) return res.status(404).json({ error: 'Not found' });
        const rl = limiters.history.hit(ipOf(req));
        if (!rl.ok) return limited(res, rl);
        const q = req.query || {};
        const mine = q.mine === '1' || q.mine === 'true';
        let ownerId = typeof q.owner === 'string' ? q.owner.slice(0, 40) : '';
        if (mine) { const u = accounts && accounts.authenticate(bearer(req)); if (!u) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', message: 'Нужно войти в аккаунт' }); ownerId = u.id; }
        const sl = services.list({ ownerId });
        res.json({ ok: true, services: mine ? sl : hideFor('service', sl, reports && reports.hiddenIds('service').size ? viewerOf(req) : null) });
    }

    function serviceGet(req, res) {
        if (!services) return res.status(404).json({ error: 'Not found' });
        const rl = limiters.history.hit(ipOf(req));
        if (!rl.ok) return limited(res, rl);
        const s = services.get(req.params.id);
        if (!s || hiddenFrom('service', s, reports && reports.isHidden('service', s.id) ? viewerOf(req) : null)) return serviceFail(res, { code: 'SERVICE_NOT_FOUND', message: 'Карточка не найдена' });
        res.json({ ok: true, service: s });
    }

    async function serviceSave(req, res) {
        if (!services) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.serviceWrite.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const isNewSvc = !(req.body && typeof req.body.id === 'string' && req.body.id);
        const hold = invites && isNewSvc ? invites.reserve(user.id, 'services') : null;
        if (hold && !hold.ok) return dailyLimit(res, hold.quota);
        const r = await services.save(user, req.body);
        if (!r.ok) { if (hold) hold.undo(); return serviceFail(res, r); }
        if (invites && r.created) { await invites.flush(); await afterPublish(user); }
        res.json({ ok: true, service: r.service, created: r.created });
    }

    async function serviceBump(req, res) {
        if (!services) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.serviceWrite.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const r = await services.bump(user, req.params.id);
        if (!r.ok) return serviceFail(res, r);
        res.json({ ok: true, service: r.service });
    }

    async function serviceDelete(req, res) {
        if (!services) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.serviceWrite.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const r = await services.remove(user, req.params.id);
        if (!r.ok) return serviceFail(res, r);
        res.json({ ok: true });
    }

    // ---------- «Курортный движ» ----------
    const dvizFail = (res, r) => res.status(
        r.code === 'DVIZ_NOT_FOUND' || r.code === 'SERVICE_NOT_FOUND' ? 404 : r.code === 'NOT_OWNER' ? 403 : r.code === 'STORE_UNAVAILABLE' || r.code === 'LISTINGS_FULL' ? 503 :
        r.code === 'DVIZ_FULL' || r.code === 'DVIZ_OWN' || r.code === 'TOO_MANY_DVIZ' ? 409 : 400
    ).json({ ok: false, code: r.code, message: r.message });
    const viewerOf = (req) => { const t = bearer(req); const u = t && accounts ? accounts.authenticate(t) : null; return u ? u.id : null; };

    function dvizList(req, res) {
        if (!dviz) return res.status(404).json({ error: 'Not found' });
        const rl = limiters.history.hit(ipOf(req));
        if (!rl.ok) return limited(res, rl);
        const q = req.query || {};
        let ownerId = typeof q.owner === 'string' ? q.owner.slice(0, 40) : '';
        if (q.mine === '1') { const me = viewerOf(req); if (!me) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', message: 'Нужно войти в аккаунт' }); ownerId = me; }
        const me = viewerOf(req);
        res.json({ ok: true, events: withOwner(q.mine === '1' ? dviz.list({ viewerId: me, ownerId }) : hideFor('dviz', dviz.list({ viewerId: me, ownerId }), me)) });
    }

    function dvizGet(req, res) {
        if (!dviz) return res.status(404).json({ error: 'Not found' });
        const rl = limiters.history.hit(ipOf(req));
        if (!rl.ok) return limited(res, rl);
        const e = dviz.get(req.params.id, viewerOf(req));
        if (!e || hiddenFrom('dviz', e, reports && reports.isHidden('dviz', e.id) ? viewerOf(req) : null)) return dvizFail(res, { code: 'DVIZ_NOT_FOUND', message: 'Этот движ уже закончился или удалён' });
        res.json({ ok: true, event: e });
    }

    async function dvizCreate(req, res) {
        if (!dviz) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.dvizWrite.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const r = await dviz.create(user, req.body);
        if (!r.ok) return dvizFail(res, r);
        await afterPublish(user);
        if (io && typeof io.emit === 'function') io.emit('dviz-changed', { id: r.event.id });
        res.json({ ok: true, event: r.event });
    }

    async function dvizDelete(req, res) {
        if (!dviz) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.dvizWrite.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const r = await dviz.remove(user, req.params.id);
        if (!r.ok) return dvizFail(res, r);
        if (io && typeof io.emit === 'function') io.emit('dviz-changed', { id: req.params.id, removed: true });
        res.json({ ok: true });
    }

    async function dvizComment(req, res) {
        if (!dviz) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.dvizTalk.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const r = await dviz.comment(user, req.params.id, req.body && req.body.text);
        if (!r.ok) return dvizFail(res, r);
        if (notifier && r.ownerId && r.ownerId !== user.id) notifier.notify([r.ownerId], { kind: 'dviz', title: user.name + ' · ' + trunc(r.title, 40), body: trunc(r.comment.text, 100), open: 'room:dating', tag: 'dviz:' + req.params.id });
        if (io && typeof io.emit === 'function') io.emit('dviz-changed', { id: req.params.id });
        res.json({ ok: true, comment: r.comment, comments: r.event.comments });
    }

    async function dvizCommentDelete(req, res) {
        if (!dviz) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.dvizTalk.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const r = await dviz.removeComment(user, req.params.id, req.params.cid);
        if (!r.ok) return dvizFail(res, r);
        if (io && typeof io.emit === 'function') io.emit('dviz-changed', { id: req.params.id });
        res.json({ ok: true });
    }

    async function dvizJoin(req, res) {
        if (!dviz) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.dvizTalk.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const r = await dviz.toggleJoin(user, req.params.id);
        if (!r.ok) return dvizFail(res, r);
        if (r.joined && notifier && r.ownerId) notifier.notify([r.ownerId], { kind: 'dviz', title: 'Новый отклик на движ', body: user.name + ' идёт на «' + trunc(r.title, 50) + '»', open: 'room:dating', tag: 'dviz:' + req.params.id });
        if (io && typeof io.emit === 'function') io.emit('dviz-changed', { id: req.params.id });
        res.json({ ok: true, joined: r.joined, joins: r.event.joins });
    }

    async function adminDviz(req, res) {
        if (!dviz) return res.status(404).json({ error: 'Not found' });
        if (!(await requireAdmin(req, res, 'view_dviz', {}))) return;
        res.json({ ok: true, events: dviz.listAll() });
    }

    async function adminDvizDelete(req, res) {
        if (!dviz) return res.status(404).json({ error: 'Not found' });
        if (!(await requireAdmin(req, res, 'delete_dviz', { id: trunc(req.params.id, 40) }))) return;
        const r = await dviz.remove(null, req.params.id, { admin: true });
        if (!r.ok) return dvizFail(res, r);
        await admin.audit('delete_dviz', { id: trunc(req.params.id, 40), owner: trunc(r.event.ownerName, 40), title: trunc(r.event.title, 60), ip: ipOf(req) });
        if (io && typeof io.emit === 'function') io.emit('dviz-changed', { id: req.params.id, removed: true });
        res.json({ ok: true });
    }

    async function listingBump(req, res) {
        if (!listings) return res.status(404).json({ error: 'Not found' });
        const user = needUser(req, res); if (!user) return;
        const rl = limiters.listingSave.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const r = await listings.bump(user, req.params.id);
        if (!r.ok) return listingFail(res, r);
        io.emit('listing-changed', { id: r.listing.id });
        res.json({ ok: true, listing: r.listing });
    }

    async function adminServices(req, res) {
        if (!services) return res.status(404).json({ error: 'Not found' });
        if (!(await requireAdmin(req, res, 'view_services', {}))) return;
        res.json({ ok: true, services: services.listAll() });
    }

    async function adminServiceDelete(req, res) {
        if (!services) return res.status(404).json({ error: 'Not found' });
        if (!(await requireAdmin(req, res, 'delete_service', { id: trunc(req.params.id, 40) }))) return;
        const r = await services.remove(null, req.params.id, { admin: true });
        if (!r.ok) return serviceFail(res, r);
        await admin.audit('delete_service', { id: trunc(req.params.id, 40), owner: trunc(r.service.ownerName, 40), title: trunc(r.service.title, 60), ip: ipOf(req) });
        res.json({ ok: true });
    }

    function notFound(req, res) { res.status(404).json({ error: 'Not found' }); }

    function onError(err, req, res, next) { // eslint-disable-line no-unused-vars
        if (res.headersSent) return;
        if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
            return res.status(400).json({ ok: false, code: 'BAD_PAYLOAD', message: 'Некорректный запрос' });
        }
        logger.error?.(`HTTP ошибка: ${err && err.message}`);
        res.status(500).json({ error: 'Ошибка сервера' });
    }

    // ---- видеосообщения ----
    async function mediaUpload(req, res) {
        const u = accounts && accounts.authenticate(bearer(req));
        if (!u) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED' });
        if (!media) return res.status(503).json({ ok: false, code: 'SERVER_ERROR' });
        const rl = limiters.mediaUpload.hit(u.id);
        if (!rl.ok) return limited(res, rl);
        const mediaKind = req.query && req.query.kind === 'voice' ? 'voice' : (req.query && req.query.kind === 'photo' ? 'photo' : 'video');
        const r = await media.save(u.id, Buffer.isBuffer(req.body) ? req.body : null, req.query && req.query.dur, mediaKind);
        if (!r.ok) return res.status(r.code === 'TOO_LARGE' ? 413 : (r.code === 'STORE_UNAVAILABLE' ? 503 : 400)).json({ ok: false, code: r.code });
        res.json({ ok: true, id: r.id, dur: r.dur, url: '/api/media/' + r.id });
    }

    function mediaGet(req, res) {
        const m = media && media.get(req.params.id);
        if (!m) return res.status(404).json({ error: 'Не найдено' });
        res.set('Content-Type', m.mime);
        res.set('Cache-Control', 'private, max-age=86400');
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        // sendFile сам обрабатывает Range — без него видео не перематывается в Safari
        res.sendFile(m.path, { cacheControl: false, headers: { 'Content-Type': m.mime } }, (e) => { if (e && !res.headersSent) res.status(404).end(); });
    }

    return { authOptions, recoveryInfo, recoveryCodeNew, emailStart, emailConfirm, emailRemove, resetStart, resetConfirm, accountDelete, passwordChange, reportCreate, blocksList, blockSet, adminContentReports, adminContentReportClose, invitesMe, mediaUpload, mediaGet, security, generalLimit, root, healthz, readyz, history, clearRoom, exportAll, register, login, logout, rename, me, avatarsByNames, setAvatar, verifyRequest, adminVerify, adminVerifyRequests, adminOverview, adminMessages, adminDeleteMessage, adminPurgeUser, adminUsers, adminBan, adminVerifyReject, adminListings, adminDeleteListing, adminRequests, adminDeleteRequest, adminDviz, adminDvizDelete, dvizList, dvizGet, dvizCreate, dvizDelete, dvizComment, dvizCommentDelete, dvizJoin, adminImpersonate, supportGuard, adminReports, adminReportClose, adminReviews, adminReviewDelete, servicesList, serviceGet, serviceSave, serviceBump, serviceDelete, listingBump, adminServices, adminServiceDelete, userProfile, myStats, searchesList, searchAdd, searchRemove, reviewsList, reviewSave, reviewDelete, reviewReply, adminAudit, weatherGet, adminWeatherGet, adminWeatherSet, adminWeatherRefresh, panel, pushKey, pushSubscribe, pushUnsubscribe, listingsList, listingGet, listingSave, listingDelete, listingQuota, requestsList, requestCreate, requestEdit, requestStatus, requestDelete, requestNotify, favList, favSet, inboxList, inboxRead, inboxPrefs, requestMatches, requestsMatching, requestOffer, requestOffers, requestOfferReject, notFound, onError };
}

function createApp({ express, cors, cfg, store, admin, accounts, listings, requests = null, inbox = null, favorites = null, reviews = null, services = null, dviz = null, stats = null, searches = null, media = null, dms = null, weather = null, invites = null, groups = null, adReacts = null, reports = null, mailer = null, limiters, io, push, pushStore, notifier, logger }) {
    const app = express();
    if (cfg.trustProxy) app.set('trust proxy', 1);
    app.disable('x-powered-by');

    const h = createHandlers({ cfg, store, admin, accounts, listings, requests, inbox, favorites, reviews, services, dviz, stats, searches, media, dms, weather, invites, groups, adReacts, reports, mailer, limiters, io, push, pushStore, notifier, logger });
    app.use(cors({
        origin: (origin, cb) => cb(null, !origin || isOriginAllowed(origin, cfg)),
        methods: ['GET', 'POST', 'DELETE'],
        allowedHeaders: ['Authorization', 'Content-Type']
    }));
    app.use(h.security);
    app.get('/healthz', h.healthz);   // без лимита: им пользуется мониторинг Render
    app.get('/readyz', h.readyz);
    app.get('/api/media/:id', h.mediaGet);   // видео скачивается кусками (Range) — общий лимит ему не нужен
    app.use(h.generalLimit);
    app.get('/', h.root);
    app.get('/api/messages/:room', h.history);
    app.delete('/api/messages/:room', h.clearRoom);
    app.get('/api/admin/export', h.exportAll);
    app.get('/admin', h.panel('html'));
    app.get('/admin/admin.js', h.panel('js'));
    app.get('/admin/admin.css', h.panel('css'));
    app.use('/api/admin', express.json({ limit: '2kb' }));
    app.post('/api/admin/verify', h.adminVerify);
    app.post('/api/admin/verify-reject', h.adminVerifyReject);
    app.get('/api/admin/verify-requests', h.adminVerifyRequests);
    app.get('/api/admin/overview', h.adminOverview);
    app.get('/api/admin/messages/:room', h.adminMessages);
    app.delete('/api/admin/messages/:room/:id', h.adminDeleteMessage);
    app.post('/api/admin/purge-user', h.adminPurgeUser);
    app.get('/api/admin/users', h.adminUsers);
    app.post('/api/admin/ban', h.adminBan);
    app.get('/api/admin/listings', h.adminListings);
    app.delete('/api/admin/listings/:id', h.adminDeleteListing);
    app.get('/api/admin/reviews', h.adminReviews);
    app.delete('/api/admin/reviews/:id', h.adminReviewDelete);
    app.get('/api/admin/services', h.adminServices);
    app.delete('/api/admin/services/:id', h.adminServiceDelete);
    app.post('/api/admin/impersonate', h.adminImpersonate);
    app.get('/api/admin/dviz', h.adminDviz);
    app.delete('/api/admin/dviz/:id', h.adminDvizDelete);
    app.get('/api/admin/requests', h.adminRequests);
    app.delete('/api/admin/requests/:id', h.adminDeleteRequest);
    app.get('/api/admin/audit', h.adminAudit);
    app.get('/api/weather', h.weatherGet);
    app.use('/api', h.supportGuard);
    app.get('/api/admin/weather', h.adminWeatherGet);
    app.post('/api/admin/weather', express.json({ limit: '1kb' }), h.adminWeatherSet);
    app.post('/api/admin/weather/refresh', h.adminWeatherRefresh);
    app.get('/api/admin/reports', h.adminReports);
    app.post('/api/admin/reports/:id/close', h.adminReportClose);
    app.use('/api/auth', express.json({ limit: '2kb' }));
    app.post('/api/auth/register', h.register);
    app.post('/api/auth/login', h.login);
    app.post('/api/auth/logout', h.logout);
    app.post('/api/auth/rename', h.rename);
    app.post('/api/auth/avatar', h.setAvatar);
    app.post('/api/auth/verify-request', h.verifyRequest);
    app.get('/api/auth/me', h.me);
    app.delete('/api/auth/account', express.json({ limit: '1kb' }), h.accountDelete);
    app.post('/api/auth/password', express.json({ limit: '1kb' }), h.passwordChange);
    app.get('/api/auth/options', h.authOptions);
    app.get('/api/auth/recovery', h.recoveryInfo);
    app.post('/api/auth/recovery-code', h.recoveryCodeNew);
    app.post('/api/auth/email', h.emailStart);
    app.post('/api/auth/email/confirm', h.emailConfirm);
    app.delete('/api/auth/email', h.emailRemove);
    app.post('/api/auth/reset', h.resetStart);
    app.post('/api/auth/reset/confirm', h.resetConfirm);
    app.post('/api/reports', express.json({ limit: '2kb' }), h.reportCreate);
    app.get('/api/blocks', h.blocksList);
    app.post('/api/blocks', express.json({ limit: '1kb' }), h.blockSet);
    app.get('/api/admin/content-reports', h.adminContentReports);
    app.post('/api/admin/content-reports/:id/close', express.json({ limit: '1kb' }), h.adminContentReportClose);
    app.get('/api/avatars', h.avatarsByNames);
    app.get('/api/push/key', h.pushKey);
    app.use('/api/push', express.json({ limit: '4kb' }));
    app.post('/api/push/subscribe', h.pushSubscribe);
    app.post('/api/push/unsubscribe', h.pushUnsubscribe);
    app.post('/api/media/video', express.raw({ type: ['video/webm', 'video/mp4', 'audio/webm', 'audio/mp4', 'audio/ogg', 'image/jpeg', 'image/png', 'image/webp'], limit: '7mb' }), h.mediaUpload);
    app.get('/api/profile', h.userProfile);
    app.get('/api/my/stats', h.myStats);
    app.get('/api/searches', h.searchesList);
    app.post('/api/searches', express.json({ limit: '2kb' }), h.searchAdd);
    app.delete('/api/searches/:id', h.searchRemove);
    app.get('/api/listings', h.listingsList);
    app.get('/api/listings/quota', h.listingQuota);
    app.get('/api/invites/me', h.invitesMe);
    app.get('/api/listings/:id', h.listingGet);
    app.get('/api/listings/:id/reviews', h.reviewsList);
    app.post('/api/listings/:id/reviews', express.json({ limit: '4kb' }), h.reviewSave);
    app.post('/api/reviews/:id/reply', express.json({ limit: '2kb' }), h.reviewReply);
    app.delete('/api/reviews/:id', h.reviewDelete);
    app.post('/api/listings', express.json({ limit: '5mb' }), h.listingSave);
    app.post('/api/listings/:id/bump', express.json({ limit: '1kb' }), h.listingBump);
    app.get('/api/dviz', h.dvizList);
    app.get('/api/dviz/:id', h.dvizGet);
    app.post('/api/dviz', express.json({ limit: '3mb' }), h.dvizCreate);
    app.delete('/api/dviz/:id', h.dvizDelete);
    app.post('/api/dviz/:id/comments', express.json({ limit: '4kb' }), h.dvizComment);
    app.delete('/api/dviz/:id/comments/:cid', h.dvizCommentDelete);
    app.post('/api/dviz/:id/join', express.json({ limit: '1kb' }), h.dvizJoin);
    app.get('/api/services', h.servicesList);
    app.get('/api/services/:id', h.serviceGet);
    app.post('/api/services', express.json({ limit: '3mb' }), h.serviceSave);
    app.post('/api/services/:id/bump', express.json({ limit: '1kb' }), h.serviceBump);
    app.delete('/api/services/:id', h.serviceDelete);
    app.delete('/api/listings/:id', h.listingDelete);
    app.get('/api/notifications', h.inboxList);
    app.post('/api/notifications/read', express.json({ limit: '4kb' }), h.inboxRead);
    app.post('/api/notifications/prefs', express.json({ limit: '1kb' }), h.inboxPrefs);
    app.get('/api/favorites', h.favList);
    app.post('/api/favorites', express.json({ limit: '1kb' }), h.favSet);
    app.get('/api/requests', h.requestsList);
    app.get('/api/requests/matching', h.requestsMatching);
    app.get('/api/requests/:id/matches', h.requestMatches);
    app.get('/api/requests/:id/offers', h.requestOffers);
    app.post('/api/requests/:id/offers', express.json({ limit: '2kb' }), h.requestOffer);
    app.post('/api/requests/:id/offers/:oid/reject', express.json({ limit: '1kb' }), h.requestOfferReject);
    app.post('/api/requests', express.json({ limit: '8kb' }), h.requestCreate);
    app.post('/api/requests/:id/notify', express.json({ limit: '1kb' }), h.requestNotify);
    app.post('/api/requests/:id/status', express.json({ limit: '2kb' }), h.requestStatus);
    app.post('/api/requests/:id', express.json({ limit: '8kb' }), h.requestEdit);
    app.delete('/api/requests/:id', h.requestDelete);
    app.use(h.notFound);
    app.use(h.onError);
    return app;
}

module.exports = { createApp, createHandlers };
