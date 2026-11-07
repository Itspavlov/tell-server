'use strict';
// ============================================
// Хранилище сообщений (файл messages.json).
// Формат файла прежний: { "housing": [ ... ], ... }
//
// Что изменилось по сравнению с v1:
//  - запись атомарная (временный файл + переименование + fsync);
//  - перед работой делается резервная копия, последние 20 хранятся;
//  - повреждённый файл НЕ затирается (сервер откажется стартовать);
//  - сообщение подтверждается клиенту только после записи на диск;
//  - при ошибке записи сообщение откатывается, клиент получает ошибку;
//  - повторная отправка с тем же clientId не создаёт дубликат;
//  - история отдаётся порциями;
//  - неизвестные комнаты из старого файла сохраняются, но не раздаются.
//
// Ограничение: файл по-прежнему не переживает пересоздание
// диска на Render без Persistent Disk. Постоянное хранение — PostgreSQL (этап 3).
// ============================================

const fsp = require('fs').promises;
const path = require('path');
const { IMAGE_RE, avatarFor, REACTIONS } = require('./validate');

const RECENT_TTL_MS = 10 * 60 * 1000;
const RECENT_MAX = 5000;

class StoreError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

class MessageStore {
    constructor(opts) {
        this.dir = opts.dataDir;
        this.file = path.join(this.dir, 'messages.json');
        this.backupDir = path.join(this.dir, 'backups');
        this.rooms = opts.rooms;
        this.roomCap = opts.roomCap;
        this.maxStoreBytes = opts.maxStoreBytes;
        this.flushDelayMs = opts.flushDelayMs ?? 150;
        this.keepBackups = opts.keepBackups ?? 20;
        this.logger = opts.logger || console;
        this.fs = opts.fsImpl || fsp;
        this.now = opts.now || Date.now;

        this.data = {};
        this.ready = false;
        this.closed = false;
        this.lastWriteOk = true;
        this.bytes = 0;

        this.waiters = [];
        this.timer = null;
        this.current = null;      // выполняющаяся запись
        this.recent = new Map();  // clientKey -> { message, ts }
        this.inflight = new Map();
        this.badImages = new Set();
    }

    // ---------- запуск ----------
    async init() {
        await this.fs.mkdir(this.dir, { recursive: true });

        let raw = null;
        try {
            raw = await this.fs.readFile(this.file, 'utf-8');
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }

        if (raw !== null && raw.trim() !== '') {
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (e) {
                throw new StoreError('CORRUPT',
                    `Файл ${this.file} повреждён и не читается. Сервер не запущен, чтобы не затереть историю. ` +
                    'Восстановите файл из data/backups/ и запустите снова.');
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
                Object.values(parsed).some(v => !Array.isArray(v))) {
                throw new StoreError('CORRUPT', `Файл ${this.file} имеет неожиданный формат. Сервер не запущен.`);
            }
            await this._backup(raw);
            this.data = parsed;
            this.bytes = Buffer.byteLength(raw);
        }

        for (const r of this.rooms) {
            if (!Array.isArray(this.data[r])) this.data[r] = [];
        }
        this._scanLegacyImages();
        this.ready = true;
        const total = this.rooms.reduce((s, r) => s + this.data[r].length, 0);
        this.logger.info?.(`Хранилище готово: сообщений ${total}, размер ${(this.bytes / 1048576).toFixed(2)} МБ`);
    }

    async _backup(raw) {
        await this.fs.mkdir(this.backupDir, { recursive: true });
        const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
        await this.fs.writeFile(path.join(this.backupDir, `messages-${stamp}.json`), raw, 'utf-8');
        const names = (await this.fs.readdir(this.backupDir))
            .filter(n => /^messages-.*\.json$/.test(n)).sort();
        for (const old of names.slice(0, Math.max(0, names.length - this.keepBackups))) {
            await this.fs.unlink(path.join(this.backupDir, old)).catch(() => {});
        }
    }

    // Старые сообщения могли быть сохранены без проверок. Не удаляем их из файла,
    // но опасные картинки никогда не отдаём клиентам.
    _scanLegacyImages() {
        for (const list of Object.values(this.data)) {
            for (const m of list) {
                if (m && typeof m.image === 'string' && m.image && !IMAGE_RE.test(m.image)) {
                    this.badImages.add(m.id);
                }
            }
        }
        if (this.badImages.size) {
            this.logger.warn?.(`Найдено сообщений с недопустимым изображением (не отдаются клиентам): ${this.badImages.size}`);
        }
    }

    // Безопасное представление сообщения для клиента
    _publicView(m, viewer = null) {
        const user = typeof m.user === 'string' ? m.user.slice(0, 40) : 'Гость';
        const reactions = {};
        const mine = [];
        if (m.reactions && typeof m.reactions === 'object') {
            for (const e of REACTIONS) {
                const arr = m.reactions[e];
                if (Array.isArray(arr) && arr.length) {
                    reactions[e] = arr.length;
                    if (viewer && arr.includes(viewer)) mine.push(e);
                }
            }
        }
        const r = m.reply && typeof m.reply === 'object' ? m.reply : null;
        return {
            reply: r ? { id: String(r.id || '').slice(0, 80), user: String(r.user || '').slice(0, 40), text: String(r.text || '').slice(0, 100) } : null,
            reactions, mine,
            id: typeof m.id === 'string' ? m.id : '',
            user,
            text: typeof m.text === 'string' ? m.text : '',
            avatar: avatarFor(user),
            image: (typeof m.image === 'string' && m.image && !this.badImages.has(m.id)) ? m.image : null,
            time: Number.isFinite(m.time) ? m.time : 0
        };
    }

    isReady() { return this.ready && !this.closed; }

    // Безопасное представление для рассылки
    publicView(m, viewer = null) { return this._publicView(m, viewer); }

    // Уже ли сообщение с таким clientKey было принято (повторная отправка)
    isKnown(key) {
        const hit = this.recent.get(key);
        return !!((hit && this.now() - hit.ts < RECENT_TTL_MS) || this.inflight.has(key));
    }

    canAcceptImage() { return this.bytes < this.maxStoreBytes; }

    // ---------- чтение ----------
    // before — id сообщения: вернуть более старые, чем оно
    getHistory(room, { limit = 100, before = null, viewer = null } = {}) {
        const list = this.rooms.includes(room) ? this.data[room] : null;
        if (!Array.isArray(list)) return { messages: [], hasMore: false, nextBefore: null };

        let end = list.length;
        if (before) {
            const idx = list.findIndex(m => m && m.id === before);
            end = idx >= 0 ? idx : 0;
        }
        const start = Math.max(0, end - limit);
        const messages = list.slice(start, end).filter(Boolean).map(m => this._publicView(m, viewer));
        return { messages, hasMore: start > 0, nextBefore: messages.length ? messages[0].id : null };
    }

    stats() {
        const rooms = {};
        for (const r of this.rooms) rooms[r] = (this.data[r] || []).length;
        return { ready: this.isReady(), lastWriteOk: this.lastWriteOk, bytes: this.bytes, rooms };
    }

    exportAll() {
        return JSON.parse(JSON.stringify(this.data));
    }

    // ---------- запись ----------
    // Возвращает { message, duplicate }. Бросает StoreError, если сохранить не удалось.
    async append(room, message, clientKey = null) {
        if (!this.isReady()) throw new StoreError('STORE_UNAVAILABLE');
        if (!this.rooms.includes(room)) throw new StoreError('INVALID_ROOM');

        if (clientKey) {
            const hit = this.recent.get(clientKey);
            if (hit && this.now() - hit.ts < RECENT_TTL_MS) return { message: hit.message, duplicate: true };
            const pending = this.inflight.get(clientKey);
            if (pending) {
                const res = await pending;
                return { message: res.message, duplicate: true };
            }
        }

        const run = this._appendInner(room, message);
        if (clientKey) this.inflight.set(clientKey, run);
        try {
            const res = await run;
            if (clientKey) this._remember(clientKey, res.message);
            return res;
        } finally {
            if (clientKey) this.inflight.delete(clientKey);
        }
    }

    async _appendInner(room, message) {
        if (message.image && !this.canAcceptImage()) throw new StoreError('STORE_FULL');

        const list = this.data[room];
        list.push(message);
        const dropped = [];
        while (list.length > this.roomCap) dropped.push(list.shift());

        const undo = () => {
            const i = list.lastIndexOf(message);
            if (i >= 0) list.splice(i, 1);
            list.unshift(...dropped);
        };
        await this._commit(undo);
        return { message, duplicate: false };
    }

    findMessage(room, id) {
        const list = this.rooms.includes(room) ? this.data[room] : null;
        return Array.isArray(list) ? list.find(m => m && m.id === id) || null : null;
    }

    // Поставить/снять реакцию. Возвращает { counts, mine }.
    async react(room, id, emoji, voter) {
        if (!this.isReady()) throw new StoreError('STORE_UNAVAILABLE');
        if (!REACTIONS.includes(emoji)) throw new StoreError('BAD_REACTION');
        const m = this.findMessage(room, id);
        if (!m) throw new StoreError('MESSAGE_NOT_FOUND');
        const prev = JSON.stringify(m.reactions || {});
        if (!m.reactions || typeof m.reactions !== 'object') m.reactions = {};
        const arr = Array.isArray(m.reactions[emoji]) ? m.reactions[emoji] : (m.reactions[emoji] = []);
        const i = arr.indexOf(voter);
        if (i >= 0) arr.splice(i, 1);
        else if (arr.length < 200) arr.push(voter);
        if (!arr.length) delete m.reactions[emoji];
        const undo = () => { m.reactions = JSON.parse(prev); };
        await this._commit(undo);
        const v = this._publicView(m, voter);
        return { counts: v.reactions, mine: v.mine };
    }

    // Удаление одного сообщения (модерация)
    async removeMessage(room, id) {
        if (!this.isReady()) throw new StoreError('STORE_UNAVAILABLE');
        if (!this.rooms.includes(room)) throw new StoreError('INVALID_ROOM');
        const list = this.data[room];
        const i = Array.isArray(list) ? list.findIndex(m => m && m.id === id) : -1;
        if (i < 0) return false;
        const [m] = list.splice(i, 1);
        const undo = () => { list.splice(Math.min(i, list.length), 0, m); };
        await this._commit(undo);
        for (const [k, v] of this.recent) if (v.message && v.message.id === id) this.recent.delete(k);
        return true;
    }

    // Автор сменил имя: старые сообщения в комнатах подписываем новым
    async renameUser(oldName, newName) {
        if (!this.isReady()) return 0;
        const want = String(oldName || '').trim().toLowerCase();
        if (!want) return 0;
        const touched = [];
        for (const room of this.rooms) for (const m of (this.data[room] || [])) {
            if (m && typeof m.user === 'string' && m.user.trim().toLowerCase() === want) { touched.push([m, m.user]); m.user = newName; }
        }
        if (!touched.length) return 0;
        try { await this._commit(() => { for (const [m, u] of touched) m.user = u; }); }
        catch (e) { return 0; }
        return touched.length;
    }

    // Удаление всего, что написал автор с таким именем (спам). Возвращает [{room,id}]
    async removeByUser(name) {
        if (!this.isReady()) throw new StoreError('STORE_UNAVAILABLE');
        const want = String(name || '').trim().toLowerCase();
        if (!want) return [];
        const removed = [], backup = {};
        for (const room of this.rooms) {
            const list = this.data[room] || [];
            const keep = list.filter(m => !(m && typeof m.user === 'string' && m.user.trim().toLowerCase() === want));
            if (keep.length !== list.length) {
                backup[room] = list;
                for (const m of list) if (!keep.includes(m)) removed.push({ room, id: m.id });
                this.data[room] = keep;
            }
        }
        if (!removed.length) return [];
        const undo = () => { for (const r of Object.keys(backup)) this.data[r] = backup[r]; };
        await this._commit(undo);
        const ids = new Set(removed.map(r => r.id));
        for (const [k, v] of this.recent) if (v.message && ids.has(v.message.id)) this.recent.delete(k);
        return removed;
    }

    // Очистка комнаты (только для администратора)
    async clear(room) {
        if (!this.isReady()) throw new StoreError('STORE_UNAVAILABLE');
        if (!this.rooms.includes(room)) throw new StoreError('INVALID_ROOM');
        const old = this.data[room];
        this.data[room] = [];
        const undo = () => { this.data[room] = old; };
        await this._commit(undo);
        for (const [k, v] of this.recent) if (k.startsWith(room + '|')) this.recent.delete(k);
        return old.length;
    }

    _remember(key, message) {
        this.recent.set(key, { message, ts: this.now() });
        if (this.recent.size > RECENT_MAX) {
            const oldest = this.recent.keys().next().value;
            this.recent.delete(oldest);
        }
    }

    // Ждёт, пока изменение окажется на диске. Несколько изменений пишутся одним файлом.
    _commit(undo) {
        return new Promise((resolve, reject) => {
            this.waiters.push({ resolve, reject, undo });
            if (!this.timer && !this.current) {
                this.timer = setTimeout(() => this._run(), this.flushDelayMs);
            }
        });
    }

    _run() {
        this.timer = null;
        if (this.current) return this.current;
        this.current = this._flushOnce().finally(() => {
            this.current = null;
            if (this.waiters.length && !this.timer) {
                this.timer = setTimeout(() => this._run(), this.flushDelayMs);
            }
        });
        return this.current;
    }

    async _flushOnce() {
        const batch = this.waiters;
        this.waiters = [];
        if (!batch.length) return;
        try {
            await this._write();
            this.lastWriteOk = true;
            batch.forEach(w => w.resolve());
        } catch (err) {
            this.lastWriteOk = false;
            this.logger.error?.(`Ошибка записи истории: ${err.code || err.message}`);
            for (const w of [...batch].reverse()) w.undo();
            const e = new StoreError('STORE_UNAVAILABLE', 'Не удалось записать сообщение на диск');
            batch.forEach(w => w.reject(e));
        }
    }

    async _write() {
        const json = JSON.stringify(this.data);
        const tmp = this.file + '.tmp';
        const fh = await this.fs.open(tmp, 'w');
        try {
            await fh.writeFile(json, 'utf-8');
            await fh.sync();
        } finally {
            await fh.close();
        }
        await this.fs.rename(tmp, this.file);
        this.bytes = Buffer.byteLength(json);
    }

    // Корректное завершение: дописать всё, что ждёт записи
    async close() {
        if (this.closed) return;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        while (this.current || this.waiters.length) {
            if (this.current) await this.current;
            else await this._run();
        }
        this.closed = true;
    }
}

module.exports = { MessageStore, StoreError };
