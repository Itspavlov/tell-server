'use strict';
// ============================================
// HTTP-маршруты. Обработчики не зависят от express напрямую
// (получают req/res), поэтому проверяются тестами с поддельными объектами.
// ============================================

const { isValidRoom } = require('./validate');
const { isOriginAllowed } = require('./config');
const { fail } = require('./validate');
const { nameKey } = require('./accounts');

function createHandlers({ cfg, store, admin, accounts, listings, limiters, io, logger = console }) {
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
        res.status(201).json({ ok: true, token: r.token, user: r.user });
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

    function me(req, res) {
        if (!accounts) return res.status(404).json({ error: 'Not found' });
        const u = accounts.authenticate(bearer(req));
        if (!u) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED' });
        res.json({ ok: true, user: { id: u.id, name: u.name, verified: !!u.verified } });
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
        const ok = await accounts.setVerified(nameKey(b.name), b.verified);
        if (!ok) return res.status(404).json({ ok: false, code: 'NO_USER' });
        await admin.audit('verify', { target: b.name.slice(0, 40), verified: b.verified, ip: ipOf(req) });
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
        await admin.audit('delete_listing', { id: trunc(req.params.id, 40), owner: trunc(r.ownerName, 40), ip: ipOf(req) });
        if (io && typeof io.emit === 'function') io.emit('listing-changed', { id: req.params.id, removed: true });
        res.json({ ok: true });
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

    // ---------- объявления ----------
    const listingFail = (res, r) => res.status(
        r.code === 'LISTING_NOT_FOUND' ? 404 : (r.code === 'NOT_OWNER' || r.code === 'NOT_VERIFIED') ? 403 :
        (r.code === 'STORE_UNAVAILABLE' || r.code === 'LISTINGS_FULL') ? 503 : 400
    ).json({ ok: false, code: r.code, message: r.message });

    function listingsList(req, res) {
        if (!listings) return res.status(404).json({ error: 'Not found' });
        const r = limiters.history.hit(ipOf(req));
        if (!r.ok) return limited(res, r);
        res.json({ ok: true, listings: listings.list() });
    }

    function listingGet(req, res) {
        if (!listings) return res.status(404).json({ error: 'Not found' });
        const r = limiters.history.hit(ipOf(req));
        if (!r.ok) return limited(res, r);
        const l = listings.get(req.params.id);
        if (!l) return res.status(404).json({ ok: false, code: 'LISTING_NOT_FOUND' });
        res.json({ ok: true, listing: l });
    }

    async function listingSave(req, res) {
        if (!listings) return res.status(404).json({ error: 'Not found' });
        const user = accounts && accounts.authenticate(bearer(req));
        if (!user) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', message: 'Нужно войти в аккаунт' });
        const rl = limiters.listingSave.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const r = await listings.save(user, req.body);
        if (!r.ok) return listingFail(res, r);
        io.emit('listing-changed', { id: r.listing.id });
        res.json({ ok: true, listing: r.listing });
    }

    async function listingDelete(req, res) {
        if (!listings) return res.status(404).json({ error: 'Not found' });
        const user = accounts && accounts.authenticate(bearer(req));
        if (!user) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', message: 'Нужно войти в аккаунт' });
        const rl = limiters.listingSave.hit(user.id);
        if (!rl.ok) return limited(res, rl);
        const r = await listings.remove(user, req.params.id);
        if (!r.ok) return listingFail(res, r);
        io.emit('listing-changed', { id: req.params.id, removed: true });
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

    return { security, generalLimit, root, healthz, readyz, history, clearRoom, exportAll, register, login, logout, me, verifyRequest, adminVerify, adminVerifyRequests, adminOverview, adminMessages, adminDeleteMessage, adminPurgeUser, adminUsers, adminBan, adminVerifyReject, adminListings, adminDeleteListing, adminAudit, panel, listingsList, listingGet, listingSave, listingDelete, notFound, onError };
}

function createApp({ express, cors, cfg, store, admin, accounts, listings, limiters, io, logger }) {
    const app = express();
    if (cfg.trustProxy) app.set('trust proxy', 1);
    app.disable('x-powered-by');

    const h = createHandlers({ cfg, store, admin, accounts, listings, limiters, io, logger });
    app.use(cors({
        origin: (origin, cb) => cb(null, !origin || isOriginAllowed(origin, cfg)),
        methods: ['GET', 'POST', 'DELETE'],
        allowedHeaders: ['Authorization', 'Content-Type']
    }));
    app.use(h.security);
    app.get('/healthz', h.healthz);   // без лимита: им пользуется мониторинг Render
    app.get('/readyz', h.readyz);
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
    app.get('/api/admin/audit', h.adminAudit);
    app.use('/api/auth', express.json({ limit: '2kb' }));
    app.post('/api/auth/register', h.register);
    app.post('/api/auth/login', h.login);
    app.post('/api/auth/logout', h.logout);
    app.post('/api/auth/verify-request', h.verifyRequest);
    app.get('/api/auth/me', h.me);
    app.get('/api/listings', h.listingsList);
    app.get('/api/listings/:id', h.listingGet);
    app.post('/api/listings', express.json({ limit: '5mb' }), h.listingSave);
    app.delete('/api/listings/:id', h.listingDelete);
    app.use(h.notFound);
    app.use(h.onError);
    return app;
}

module.exports = { createApp, createHandlers };
