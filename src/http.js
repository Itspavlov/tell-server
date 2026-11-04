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
        if (!admin.authorize(req.headers && req.headers.authorization)) {
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
        res.json({ ok: true, user: { id: u.id, name: u.name } });
    }

    // ---------- объявления ----------
    const listingFail = (res, r) => res.status(
        r.code === 'LISTING_NOT_FOUND' ? 404 : r.code === 'NOT_OWNER' ? 403 :
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

    return { security, generalLimit, root, healthz, readyz, history, clearRoom, exportAll, register, login, logout, me, listingsList, listingGet, listingSave, listingDelete, notFound, onError };
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
    app.use('/api/auth', express.json({ limit: '2kb' }));
    app.post('/api/auth/register', h.register);
    app.post('/api/auth/login', h.login);
    app.post('/api/auth/logout', h.logout);
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
