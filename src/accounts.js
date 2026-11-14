'use strict';
// ============================================
// Аккаунты и сессии.
//  - пароль хранится только в виде scrypt-хеша с индивидуальной солью;
//  - токен сессии (32 случайных байта) выдаётся клиенту один раз,
//    на сервере хранится только его SHA-256;
//  - сессия живёт 30 дней, не более 10 сессий на пользователя.
// Хранилище — файл accounts.json. На Render без Persistent Disk он
// пропадает при пересоздании сервиса (см. README).
// ============================================
const crypto = require('crypto');
const { promisify } = require('util');
const path = require('path');
const { JsonFile } = require('./jsonfile');
const { normalizeName, validatePassword, validateEmail, fail } = require('./validate');

const scrypt = promisify(crypto.scrypt);
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const SUPPORT_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 10;
const MAX_USERS = 20000;
const AVATAR_RE = /^av(0[1-9]|[12]\d|3[0-5])$/;      // готовые аватарки av01…av35 (картинки лежат на сайте)
const SEEN_STEP_MS = 60 * 1000;                         // «был в сети» обновляем не чаще раза в минуту
const RENAME_COOLDOWN_MS = 24 * 3600 * 1000;   // имя можно менять раз в сутки: чтобы не выдавать себя за других

// Ключ имени: «Тарас», «тарас» и «Т.арас» — один и тот же человек
function nameKey(name) {
    return String(name).normalize('NFC').toLowerCase().replace(/[\s_.'\-]+/g, '');
}
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // без 0/O и 1/I: код не перепутать при переписывании
const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_TRIES = 5;
const MAIL_COOLDOWN_MS = 60 * 1000;
const RESET_FAIL_MAX = 5;
const RESET_LOCK_MS = 15 * 60 * 1000;
const hsh = (salt, v) => crypto.createHash('sha256').update(salt + ':' + v).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function newRecoveryCode() {
    let s = '';
    for (let i = 0; i < 16; i++) s += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
    return s.match(/.{4}/g).join('-');
}
function normRecovery(raw) {
    const s = String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return s.length === 16 && [...s].every((c) => RECOVERY_ALPHABET.includes(c)) ? s : '';
}
function mkRecovery(code) { const salt = crypto.randomBytes(8).toString('hex'); return { salt, hash: hsh(salt, normRecovery(code)), at: Date.now() }; }
function maskEmail(e) {
    const [l, d] = String(e).split('@');
    return (l.length <= 2 ? l[0] : l.slice(0, 2)) + '***@' + d;
}
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

class AccountStore {
    constructor({ dataDir, limits, now = Date.now, logger = console, fsImpl }) {
        this.file = new JsonFile({ file: path.join(dataDir, 'accounts.json'), fsImpl });
        this.limits = limits;
        this.now = now;
        this.logger = logger;
        this.data = { users: {}, sessions: {} };
        this.byKey = new Map();
        this.dummy = null;
        this.byEmail = new Map();       // почта -> id пользователя (только подтверждённые)
        this.mailPending = new Map();   // id -> код подтверждения почты (в памяти, живёт 15 минут)
        this.resets = new Map();        // id -> код сброса пароля (в памяти)
        this.resetFails = new Map();    // имя -> неудачные попытки сброса
    }

    async init() {
        const d = await this.file.load({ users: {}, sessions: {} });
        this.data = { users: d.users || {}, sessions: d.sessions || {} };
        for (const u of Object.values(this.data.users)) { this.byKey.set(u.key, u); if (u.email) this.byEmail.set(u.email, u.id); }
        this.dummy = { salt: crypto.randomBytes(16).toString('hex') };
        this.logger.info?.(`Аккаунты: ${this.byKey.size}`);
    }

    // Проверка бывает трёх видов: жильё (хозяева, это и есть старое поле verified), поездки (водители), развлечения (готовые услуги)
    _verifs(u) { const v = u.verifs || {}; return { housing: !!u.verified, trips: !!v.trips, services: !!v.services }; }
    _public(u) { return { id: u.id, name: u.name, key: u.key, verified: !!u.verified, verifs: this._verifs(u) }; }
    findByKey(key) { const u = this.byKey.get(key); return u ? this._public(u) : null; }
    byId(id) { const u = this.data.users[id]; return u ? this._public(u) : null; }
    isNameTaken(key) { return this.byKey.has(key); }

    // Аватарка: только id готовой картинки (av01…av35), пустая строка — без аватарки
    avatarOf(id) { const u = this.data.users[id]; return u && u.avatar ? u.avatar : ''; }
    // Аватарки по именам (для чатов и карточек): имя → id готовой картинки; тем, у кого её нет, места в ответе нет
    avatarsByNames(names) {
        const out = {};
        for (const n of (Array.isArray(names) ? names : []).slice(0, 40)) {
            if (typeof n !== 'string' || !n || n.length > 40) continue;
            const u = this.byKey.get(nameKey(n));
            if (u && u.avatar) out[n] = u.avatar;
        }
        return out;
    }
    async setAvatar(userId, value) {
        const u = this.data.users[userId];
        if (!u) return fail('AUTH_REQUIRED');
        const v = value == null ? '' : String(value);
        if (v && !AVATAR_RE.test(v)) return fail('BAD_AVATAR');
        const prev = u.avatar;
        if (v) u.avatar = v; else delete u.avatar;
        try { await this.file.save(this.data); }
        catch (e) { if (prev === undefined) delete u.avatar; else u.avatar = prev; return fail('SERVER_ERROR'); }
        return { ok: true, avatar: v };
    }

    // «Был в сети»: отмечаем действия пользователя в памяти, на диск пишем пачкой (flushSeen)
    touch(userId, force = false) {
        const u = this.data.users[userId];
        if (!u) return;
        const t = this.now();
        if (!force && u.lastSeen && t - u.lastSeen < SEEN_STEP_MS) return;
        u.lastSeen = t; this.seenDirty = true;
    }
    lastSeenOf(id) { const u = this.data.users[id]; return u && u.lastSeen ? u.lastSeen : 0; }
    async flushSeen() {
        if (!this.seenDirty) return;
        this.seenDirty = false;
        try { await this.file.save(this.data); } catch (e) { this.seenDirty = true; }
    }
    count() { return this.byKey.size; }

    async _hash(password, salt) {
        return (await scrypt(password, Buffer.from(salt, 'hex'), 64)).toString('hex');
    }

    async _newSession(userId) {
        const token = crypto.randomBytes(32).toString('hex');
        const t = this.now();
        // чистим просроченные и лишние сессии этого пользователя
        const mine = [];
        for (const [h, s] of Object.entries(this.data.sessions)) {
            if (s.exp <= t) delete this.data.sessions[h];
            else if (s.userId === userId && !s.support) mine.push([h, s]);
        }
        mine.sort((a, b) => a[1].exp - b[1].exp);
        while (mine.length >= MAX_SESSIONS) delete this.data.sessions[mine.shift()[0]];
        this.data.sessions[sha(token)] = { userId, exp: t + SESSION_TTL_MS };
        return token;
    }

    // Режим поддержки: короткая сессия «посмотреть глазами пользователя».
    // Личная переписка, уведомления и смена данных аккаунта в ней закрыты (см. supportGuard в http.js).
    async startSupport(key, ttlMs = SUPPORT_TTL_MS) {
        const u = this.byKey.get(key);
        if (!u || u.banned) return null;
        const token = crypto.randomBytes(32).toString('hex');
        const t = this.now();
        for (const [h, s] of Object.entries(this.data.sessions)) if (s.exp <= t) delete this.data.sessions[h];
        this.data.sessions[sha(token)] = { userId: u.id, exp: t + ttlMs, support: true };
        try { await this.file.save(this.data); } catch (e) { delete this.data.sessions[sha(token)]; return null; }
        return { token, user: this._public(u), expires: t + ttlMs };
    }

    isSupport(token) {
        if (typeof token !== 'string' || token.length !== 64) return false;
        const s = this.data.sessions[sha(token)];
        return !!(s && s.support && s.exp > this.now());
    }

    async register(rawName, password) {
        const n = normalizeName(rawName, this.limits);
        if (!n.ok) return n;
        const p = validatePassword(password);
        if (!p.ok) return p;
        if (this.byKey.size >= MAX_USERS) return fail('TOO_MANY_ACCOUNTS');
        const key = nameKey(n.value);
        if (this.byKey.has(key)) return fail('NAME_TAKEN');

        const salt = crypto.randomBytes(16).toString('hex');
        const hash = await this._hash(password, salt);
        // повторная проверка после await: две одновременные регистрации не пройдут обе
        if (this.byKey.has(key)) return fail('NAME_TAKEN');

        const recoveryCode = newRecoveryCode();
        const user = { id: 'u_' + crypto.randomBytes(8).toString('hex'), name: n.value, key, salt, hash, createdAt: this.now(), recovery: mkRecovery(recoveryCode) };
        this.data.users[user.id] = user;
        this.byKey.set(key, user);
        const token = await this._newSession(user.id);
        try { await this.file.save(this.data); }
        catch (e) {
            delete this.data.users[user.id]; this.byKey.delete(key); delete this.data.sessions[sha(token)];
            this.logger.error?.(`Аккаунт не сохранён: ${e.code || e.message}`);
            return fail('SERVER_ERROR');
        }
        return { ok: true, token, user: { id: user.id, name: user.name, verified: false }, recoveryCode };
    }

    async login(rawName, password) {
        const n = normalizeName(rawName, this.limits);
        if (!n.ok || typeof password !== 'string' || password.length > 72) return fail('BAD_CREDENTIALS');
        const user = this.byKey.get(nameKey(n.value));
        // для несуществующего имени тоже считаем хеш — время ответа не выдаёт, есть ли такой аккаунт
        const hash = await this._hash(password, user ? user.salt : this.dummy.salt);
        if (!user) return fail('BAD_CREDENTIALS');
        if (user.banned) return fail('BANNED');
        const a = Buffer.from(hash, 'hex'), b = Buffer.from(user.hash, 'hex');
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail('BAD_CREDENTIALS');
        const token = await this._newSession(user.id);
        try { await this.file.save(this.data); } catch (e) { return fail('SERVER_ERROR'); }
        return { ok: true, token, user: { id: user.id, name: user.name, verified: !!user.verified } };
    }

    // Смена имени: имя же и логин, поэтому ключ тоже меняется. Возвращает старый ключ, чтобы переписать ссылки на него
    async rename(userId, rawName) {
        const u = this.data.users[userId];
        if (!u) return fail('AUTH_REQUIRED');
        const n = normalizeName(rawName, this.limits);
        if (!n.ok) return n;
        if (n.value === u.name) return { ok: true, user: { id: u.id, name: u.name, verified: !!u.verified }, changed: false };
        const key = nameKey(n.value);
        const other = this.byKey.get(key);
        if (other && other.id !== u.id) return fail('NAME_TAKEN');
        const t = this.now();
        if (u.renamedAt && t - u.renamedAt < RENAME_COOLDOWN_MS) return fail('RENAME_WAIT', { wait: Math.ceil((RENAME_COOLDOWN_MS - (t - u.renamedAt)) / 1000) });
        const prev = { name: u.name, key: u.key, renamedAt: u.renamedAt };
        if (key !== u.key) { this.byKey.delete(u.key); this.byKey.set(key, u); }
        u.name = n.value; u.key = key; u.renamedAt = t;
        try { await this.file.save(this.data); }
        catch (e) {
            if (key !== prev.key) { this.byKey.delete(key); this.byKey.set(prev.key, u); }
            u.name = prev.name; u.key = prev.key; if (prev.renamedAt === undefined) delete u.renamedAt; else u.renamedAt = prev.renamedAt;
            this.logger.error?.(`Имя не сохранено: ${e.code || e.message}`);
            return fail('SERVER_ERROR');
        }
        return { ok: true, changed: true, user: { id: u.id, name: u.name, verified: !!u.verified }, oldKey: prev.key, oldName: prev.name };
    }

    // Проверенный хозяин: статус выдаёт только администратор
    async setVerified(key, value, kind = 'housing') {
        const u = this.byKey.get(key);
        if (!u) return false;
        if (kind !== 'housing') {
            if (kind !== 'trips' && kind !== 'services') return false;
            const had = u.verifs; u.verifs = Object.assign({}, had, { [kind]: !!value });
            try { await this.file.save(this.data); } catch (e) { u.verifs = had; return false; }
            return true;
        }
        const prev = !!u.verified;
        u.verified = !!value;
        if (u.verified) delete u.verifyRequest;
        try { await this.file.save(this.data); } catch (e) { u.verified = prev; return false; }
        return true;
    }

    async requestVerification(userId, note) {
        const u = this.data.users[userId];
        if (!u) return fail('AUTH_REQUIRED');
        if (u.verified) return { ok: true, already: true };
        const prev = u.verifyRequest;
        u.verifyRequest = { note: String(note || '').slice(0, 500), time: this.now() };
        try { await this.file.save(this.data); } catch (e) { u.verifyRequest = prev; return fail('STORE_UNAVAILABLE'); }
        return { ok: true };
    }

    listVerifyRequests() {
        return Object.values(this.data.users).filter(u => u.verifyRequest && !u.verified)
            .map(u => ({ name: u.name, note: u.verifyRequest.note, time: u.verifyRequest.time }));
    }

    authenticate(token) {
        if (typeof token !== 'string' || token.length !== 64 || !/^[0-9a-f]+$/.test(token)) return null;
        const s = this.data.sessions[sha(token)];
        if (!s || s.exp <= this.now()) return null;
        const u = this.data.users[s.userId];
        if (!u || u.banned) return null;
        const pub = this.byId(s.userId);
        if (!s.support) this.touch(u.id);          // режим поддержки «был в сети» не двигает
        return s.support ? Object.assign(pub, { support: true }) : pub;
    }

    // ----- модерация -----
    listUsers(query) {
        const q = String(query || '').trim().toLowerCase();
        return Object.values(this.data.users)
            .filter(u => !q || u.name.toLowerCase().includes(q))
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 200)
            .map(u => ({ id: u.id, name: u.name, verified: !!u.verified, verifs: this._verifs(u), banned: !!u.banned, created: u.createdAt || 0,
                         request: u.verifyRequest ? { note: u.verifyRequest.note, time: u.verifyRequest.time } : null }));
    }

    // Блокировка: все сессии сбрасываются, вход закрыт
    async setBanned(key, value) {
        const u = this.byKey.get(key);
        if (!u) return false;
        const prev = !!u.banned, prevSessions = { ...this.data.sessions };
        u.banned = !!value;
        if (u.banned) for (const [h, s] of Object.entries(this.data.sessions)) if (s.userId === u.id) delete this.data.sessions[h];
        try { await this.file.save(this.data); }
        catch (e) { u.banned = prev; this.data.sessions = prevSessions; return false; }
        return true;
    }

    async rejectVerification(key) {
        const u = this.byKey.get(key);
        if (!u || !u.verifyRequest) return false;
        const prev = u.verifyRequest;
        delete u.verifyRequest;
        try { await this.file.save(this.data); } catch (e) { u.verifyRequest = prev; return false; }
        return true;
    }

    stats() {
        const us = Object.values(this.data.users);
        return { users: us.length, verified: us.filter(u => u.verified).length, banned: us.filter(u => u.banned).length, requests: us.filter(u => u.verifyRequest && !u.verified).length };
    }

    async logout(token) {
        if (typeof token !== 'string') return;
        const h = sha(token);
        if (this.data.sessions[h]) {
            delete this.data.sessions[h];
            await this.file.save(this.data).catch(() => {});
        }
    }
}

// ----- удаление аккаунта (требование магазинов приложений) -----
// Проверка пароля действующего пользователя
AccountStore.prototype.checkPassword = async function (userId, password) {
    const u = this.data.users[userId];
    if (!u || typeof password !== 'string' || password.length > 72) return false;
    const h = Buffer.from(await this._hash(password, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
    return h.length === b.length && crypto.timingSafeEqual(h, b);
};
// Смена пароля: нужен текущий пароль; все остальные сессии (другие устройства) закрываются, текущая остаётся.
AccountStore.prototype.changePassword = async function (userId, oldPassword, newPassword, keepToken) {
    const u = this.data.users[userId];
    if (!u) return fail('NO_USER');
    if (!(await this.checkPassword(userId, oldPassword))) return fail('BAD_CREDENTIALS');
    const p = validatePassword(newPassword);
    if (!p.ok) return p;
    if (newPassword === oldPassword) return fail('SAME_PASSWORD');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await this._hash(newPassword, salt);
    const prev = { salt: u.salt, hash: u.hash }, prevSessions = { ...this.data.sessions };
    u.salt = salt; u.hash = hash;
    const keep = typeof keepToken === 'string' && keepToken.length === 64 ? sha(keepToken) : null;
    for (const [h, s] of Object.entries(this.data.sessions)) if (s.userId === userId && h !== keep) delete this.data.sessions[h];
    try { await this.file.save(this.data); }
    catch (e) {
        u.salt = prev.salt; u.hash = prev.hash; this.data.sessions = prevSessions;
        this.logger.error?.(`Пароль не сохранён: ${e.code || e.message}`);
        return fail('SERVER_ERROR');
    }
    return { ok: true };
};
// Аккаунт и все его сессии удаляются; имя снова свободно
AccountStore.prototype.removeUser = async function (userId) {
    const u = this.data.users[userId];
    if (!u) return { ok: true, already: true };
    const prevSessions = { ...this.data.sessions };
    delete this.data.users[userId]; this.byKey.delete(u.key);
    if (u.email && this.byEmail.get(u.email) === userId) this.byEmail.delete(u.email);
    this.mailPending.delete(userId); this.resets.delete(userId);
    for (const [h, s] of Object.entries(this.data.sessions)) if (s.userId === userId) delete this.data.sessions[h];
    try { await this.file.save(this.data); }
    catch (e) {
        this.data.users[userId] = u; this.byKey.set(u.key, u); this.data.sessions = prevSessions;
        if (u.email) this.byEmail.set(u.email, userId);
        this.logger.error?.(`removeUser: ${e.code || e.message}`);
        return fail('SERVER_ERROR');
    }
    return { ok: true };
};

// Отметка о согласии с политикой и соглашением (версия документов + время). Не критична: при сбое просто не запишется.
AccountStore.prototype.markConsent = async function (userId, version) {
    const u = this.data.users[userId];
    if (!u) return false;
    const prev = u.consent;
    u.consent = { v: String(version || '1').slice(0, 20), at: this.now() };
    try { await this.file.save(this.data); return true; }
    catch (e) { u.consent = prev; return false; }
};

// ---------- восстановление доступа: код восстановления, почта, сброс пароля ----------
AccountStore.prototype.recoveryStatus = function (userId) {
    const u = this.data.users[userId];
    if (!u) return fail('AUTH_REQUIRED');
    return { ok: true, hasCode: !!u.recovery, email: u.email ? maskEmail(u.email) : '' };
};
AccountStore.prototype.emailOf = function (userId) { const u = this.data.users[userId]; return u && u.email ? u.email : ''; };

// Новый код восстановления взамен прежнего (по паролю). Показывается один раз, на сервере остаётся только хеш.
AccountStore.prototype.newRecoveryCode = async function (userId, password) {
    const u = this.data.users[userId];
    if (!u) return fail('AUTH_REQUIRED');
    if (!(await this.checkPassword(userId, password))) return fail('BAD_CREDENTIALS');
    const code = newRecoveryCode(), prev = u.recovery;
    u.recovery = mkRecovery(code);
    try { await this.file.save(this.data); }
    catch (e) { if (prev) u.recovery = prev; else delete u.recovery; this.logger.error?.(`Код восстановления не сохранён: ${e.code || e.message}`); return fail('SERVER_ERROR'); }
    return { ok: true, code };
};

// Шаг 1 привязки почты: проверяем пароль и адрес, выдаём код для письма (письмо отправляет вызывающий)
AccountStore.prototype.emailStart = async function (userId, password, rawEmail) {
    const u = this.data.users[userId];
    if (!u) return fail('AUTH_REQUIRED');
    const e = validateEmail(rawEmail);
    if (!e.ok) return e;
    if (!(await this.checkPassword(userId, password))) return fail('BAD_CREDENTIALS');
    const owner = this.byEmail.get(e.value);
    if (owner && owner !== userId) return fail('EMAIL_TAKEN');
    if (u.email === e.value) return { ok: true, already: true, email: e.value };
    const t = this.now(), p = this.mailPending.get(userId);
    if (p && t - p.sentAt < MAIL_COOLDOWN_MS) return fail('MAIL_WAIT');
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'), salt = crypto.randomBytes(8).toString('hex');
    this.mailPending.set(userId, { email: e.value, salt, hash: hsh(salt, code), exp: t + CODE_TTL_MS, tries: 0, sentAt: t });
    return { ok: true, code, email: e.value };
};
AccountStore.prototype.emailCancel = function (userId) { this.mailPending.delete(userId); };

// Шаг 2: человек ввёл код из письма
AccountStore.prototype.emailConfirm = async function (userId, rawCode) {
    const u = this.data.users[userId];
    if (!u) return fail('AUTH_REQUIRED');
    const p = this.mailPending.get(userId);
    if (!p) return fail('NO_PENDING');
    if (p.exp <= this.now()) { this.mailPending.delete(userId); return fail('CODE_EXPIRED'); }
    const code = String(rawCode == null ? '' : rawCode).replace(/\D/g, '');
    if (code.length !== 6 || !safeEq(hsh(p.salt, code), p.hash)) {
        p.tries++; if (p.tries >= CODE_TRIES) this.mailPending.delete(userId);
        return fail('BAD_CODE');
    }
    const owner = this.byEmail.get(p.email);
    if (owner && owner !== userId) { this.mailPending.delete(userId); return fail('EMAIL_TAKEN'); }
    const prev = { email: u.email, emailAt: u.emailAt };
    if (u.email) this.byEmail.delete(u.email);
    u.email = p.email; u.emailAt = this.now(); this.byEmail.set(u.email, userId);
    try { await this.file.save(this.data); }
    catch (e) {
        this.byEmail.delete(u.email);
        if (prev.email) { u.email = prev.email; u.emailAt = prev.emailAt; this.byEmail.set(prev.email, userId); } else { delete u.email; delete u.emailAt; }
        this.logger.error?.(`Почта не сохранена: ${e.code || e.message}`); return fail('SERVER_ERROR');
    }
    this.mailPending.delete(userId);
    return { ok: true, email: maskEmail(u.email) };
};

AccountStore.prototype.emailRemove = async function (userId, password) {
    const u = this.data.users[userId];
    if (!u) return fail('AUTH_REQUIRED');
    if (!(await this.checkPassword(userId, password))) return fail('BAD_CREDENTIALS');
    if (!u.email) return { ok: true };
    const prev = { email: u.email, emailAt: u.emailAt };
    this.byEmail.delete(u.email); delete u.email; delete u.emailAt;
    try { await this.file.save(this.data); }
    catch (e) { u.email = prev.email; u.emailAt = prev.emailAt; this.byEmail.set(prev.email, userId); return fail('SERVER_ERROR'); }
    return { ok: true };
};

// «Забыли пароль» по почте, шаг 1. Результат наружу всегда одинаковый (none) — чужие имена не выведать.
AccountStore.prototype.resetStart = function (rawName) {
    const n = normalizeName(rawName, this.limits);
    if (!n.ok) return { ok: true, none: true };
    const u = this.byKey.get(nameKey(n.value));
    if (!u || !u.email || u.banned) return { ok: true, none: true };
    const t = this.now(), r = this.resets.get(u.id);
    if (r && t - r.sentAt < MAIL_COOLDOWN_MS) return { ok: true, none: true };
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'), salt = crypto.randomBytes(8).toString('hex');
    this.resets.set(u.id, { salt, hash: hsh(salt, code), exp: t + CODE_TTL_MS, tries: 0, sentAt: t });
    return { ok: true, userId: u.id, email: u.email, name: u.name, code };
};

// Шаг 2 (и единственный для кода восстановления): новый пароль по коду. Все сессии закрываются, выдаётся новая.
AccountStore.prototype.resetConfirm = async function (rawName, method, rawCode, newPassword) {
    const pw = validatePassword(newPassword);
    if (!pw.ok) return pw;
    const n = normalizeName(rawName, this.limits);
    const key = n.ok ? nameKey(n.value) : 'x:' + String(rawName == null ? '' : rawName).slice(0, 40);
    const t = this.now();
    let f = this.resetFails.get(key);
    if (f && f.until > t) return fail('RESET_LOCKED');
    if (f && t - f.first > RESET_LOCK_MS) { this.resetFails.delete(key); f = null; }
    const u = n.ok ? this.byKey.get(key) : null;
    let ok = false, rec = null, rst = null;
    if (u && !u.banned) {
        if (method === 'recovery') {
            const c = normRecovery(rawCode);
            if (c && u.recovery) { rec = u.recovery; ok = safeEq(hsh(rec.salt, c), rec.hash); }
        } else if (method === 'email') {
            const r = this.resets.get(u.id);
            if (r && r.exp > t) {
                const c = String(rawCode == null ? '' : rawCode).replace(/\D/g, '');
                ok = c.length === 6 && safeEq(hsh(r.salt, c), r.hash);
                if (ok) rst = r; else { r.tries++; if (r.tries >= CODE_TRIES) this.resets.delete(u.id); }
            }
        }
    }
    if (!ok) {
        const e = f || { n: 0, first: t, until: 0 };
        e.n++; if (e.n >= RESET_FAIL_MAX) e.until = t + RESET_LOCK_MS;
        this.resetFails.set(key, e);
        if (this.resetFails.size > 5000) this.resetFails.delete(this.resetFails.keys().next().value);
        return fail('RESET_FAILED');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await this._hash(pw.value, salt);
    // пока считался хеш, тот же код могли применить параллельно: код одноразовый
    if (rst ? this.resets.get(u.id) !== rst : u.recovery !== rec) return fail('RESET_FAILED');
    const prev = { salt: u.salt, hash: u.hash, recovery: u.recovery }, prevSessions = { ...this.data.sessions };
    u.salt = salt; u.hash = hash;
    for (const [h, s] of Object.entries(this.data.sessions)) if (s.userId === u.id) delete this.data.sessions[h];
    let recoveryCode = '';
    if (method === 'recovery') { recoveryCode = newRecoveryCode(); u.recovery = mkRecovery(recoveryCode); }
    const token = await this._newSession(u.id);
    try { await this.file.save(this.data); }
    catch (e) {
        u.salt = prev.salt; u.hash = prev.hash; if (prev.recovery) u.recovery = prev.recovery; else delete u.recovery;
        this.data.sessions = prevSessions;
        this.logger.error?.(`Сброс пароля не сохранён: ${e.code || e.message}`);
        return fail('SERVER_ERROR');
    }
    this.resets.delete(u.id); this.resetFails.delete(key);
    return { ok: true, token, user: { id: u.id, name: u.name, verified: !!u.verified }, recoveryCode, email: u.email || '' };
};

module.exports = { AccountStore, nameKey, newRecoveryCode, normRecovery };
