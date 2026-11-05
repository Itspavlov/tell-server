'use strict';
// ============================================
// Видеосообщения («кружочки»): хранение файлов на диске.
// Имя файла — случайный 128-битный идентификатор (его знают только
// участники диалога). Метаданные — в media.json.
// ============================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { JsonFile } = require('./jsonfile');

const MAX_BYTES = 6_000_000;      // ~60 секунд при 600 кбит/с
const MIN_BYTES = 1_000;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const ID_RE = /^vm_[0-9a-f]{32}$/;

// Тип определяется по первым байтам файла, а не по заголовку от клиента
function sniff(buf) {
    if (buf.length > 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { ext: 'webm', mime: 'video/webm' };
    if (buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp') return { ext: 'mp4', mime: 'video/mp4' };
    return null;
}

class MediaStore {
    constructor({ dataDir, now = Date.now, logger = console, fsImpl = fs.promises }) {
        this.dir = path.join(dataDir, 'media');
        this.file = new JsonFile({ file: path.join(dataDir, 'media.json'), fsImpl });
        this.fs = fsImpl;
        this.now = now;
        this.logger = logger;
        this.items = {};
    }

    async init() {
        await this.fs.mkdir(this.dir, { recursive: true });
        const d = await this.file.load({ items: {} });
        this.items = d.items || {};
        await this.sweep();
    }

    async save(ownerId, buf, dur) {
        if (!Buffer.isBuffer(buf) || buf.length < MIN_BYTES) return { ok: false, code: 'BAD_PAYLOAD' };
        if (buf.length > MAX_BYTES) return { ok: false, code: 'TOO_LARGE' };
        const kind = sniff(buf);
        if (!kind) return { ok: false, code: 'BAD_FORMAT' };
        const id = 'vm_' + crypto.randomBytes(16).toString('hex');
        const d = Math.max(1, Math.min(60, Math.round(Number(dur) || 0))) || 1;
        await this.fs.writeFile(path.join(this.dir, id + '.' + kind.ext), buf, { mode: 0o640 });
        this.items[id] = { owner: ownerId, ext: kind.ext, mime: kind.mime, size: buf.length, dur: d, time: this.now() };
        try { await this.file.save({ items: this.items }); }
        catch (e) {
            delete this.items[id];
            await this.fs.unlink(path.join(this.dir, id + '.' + kind.ext)).catch(() => {});
            return { ok: false, code: 'STORE_UNAVAILABLE' };
        }
        return { ok: true, id, dur: d };
    }

    // Файл для отдачи (id нельзя угадать); путь строится только из проверенного id
    get(id) {
        if (typeof id !== 'string' || !ID_RE.test(id)) return null;
        const it = this.items[id];
        if (!it) return null;
        return { path: path.join(this.dir, id + '.' + it.ext), mime: it.mime, size: it.size, dur: it.dur };
    }

    // Можно ли прикрепить это видео к сообщению от пользователя
    check(id, ownerId) {
        const it = typeof id === 'string' && ID_RE.test(id) ? this.items[id] : null;
        return it && it.owner === ownerId ? { ok: true, dur: it.dur } : { ok: false };
    }

    async sweep() {
        const cut = this.now() - MAX_AGE_MS;
        let n = 0;
        for (const [id, it] of Object.entries(this.items)) {
            if (it.time >= cut) continue;
            await this.fs.unlink(path.join(this.dir, id + '.' + it.ext)).catch(() => {});
            delete this.items[id]; n++;
        }
        if (n) { await this.file.save({ items: this.items }).catch(() => {}); this.logger.info?.(`Удалено старых видео: ${n}`); }
    }
}

module.exports = { MediaStore, sniff, ID_RE, MAX_BYTES };
