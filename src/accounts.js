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
const { normalizeName, validatePassword, fail } = require('./validate');

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
    }

    async init() {
        const d = await this.file.load({ users: {}, sessions: {} });
        this.data = { users: d.users || {}, sessions: d.sessions || {} };
        for (const u of Object.values(this.data.users)) this.byKey.set(u.key, u);
        this.dummy = { salt: crypto.randomBytes(16).toString('hex') };
        this.logger.info?.(`Аккаунты: ${this.byKey.size}`);
    }

    _public(u) { return { id: u.id, name: u.name, key: u.key, verified: !!u.verified }; }
    findByKey(key) { const u = this.byKey.get(key); return u ? this._public(u) : null; }
    byId(id) { const u = this.data.users[id]; return u ? this._public(u) : null; }
    isNameTaken(key) { return this.byKey.has(key); }

    // Аватарка: только id готовой картинки (av01…av35), пустая строка — без аватарки
    avatarOf(id) { const u = this.data.users[id]; return u && u.avatar ? u.avatar : ''; }
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

        const user = { id: 'u_' + crypto.randomBytes(8).toString('hex'), name: n.value, key, salt, hash, createdAt: this.now() };
        this.data.users[user.id] = user;
        this.byKey.set(key, user);
        const token = await this._newSession(user.id);
        try { await this.file.save(this.data); }
        catch (e) {
            delete this.data.users[user.id]; this.byKey.delete(key); delete this.data.sessions[sha(token)];
            this.logger.error?.(`Аккаунт не сохранён: ${e.code || e.message}`);
            return fail('SERVER_ERROR');
        }
        return { ok: true, token, user: { id: user.id, name: user.name, verified: false } };
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
    async setVerified(key, value) {
        const u = this.byKey.get(key);
        if (!u) return false;
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
            .map(u => ({ id: u.id, name: u.name, verified: !!u.verified, banned: !!u.banned, created: u.createdAt || 0,
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

module.exports = { AccountStore, nameKey };
