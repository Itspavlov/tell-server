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

const MAX_BYTES = 6_000_000;      // видео: ~60 секунд при 600 кбит/с
const MAX_VOICE_BYTES = 2_500_000; // голос: до 2 минут
const MAX_PHOTO_BYTES = 2_000_000; // фото: клиент заранее сжимает до ~1280 px
const MAX_SEC = { video: 60, voice: 120 };
const MIN_BYTES = 1_000;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const ID_RE = /^vm_[0-9a-f]{32}$/;

// Тип определяется по первым байтам файла, а не по заголовку от клиента
function sniff(buf) {
    if (buf.length > 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { ext: 'webm', mime: 'video/webm' };
    if (buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp') return { ext: 'mp4', mime: 'video/mp4' };
    if (buf.length > 4 && buf.toString('latin1', 0, 4) === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
    return null;
}

function sniffImage(buf) {
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
    if (buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return { ext: 'png', mime: 'image/png' };
    if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
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

    // kind: 'video' (кружок) или 'voice' (голосовое)
    async save(ownerId, buf, dur, mediaKind = 'video') {
        if (mediaKind !== 'video' && mediaKind !== 'voice' && mediaKind !== 'photo') return { ok: false, code: 'BAD_PAYLOAD' };
        if (!Buffer.isBuffer(buf) || buf.length < MIN_BYTES) return { ok: false, code: 'BAD_PAYLOAD' };
        if (buf.length > (mediaKind === 'voice' ? MAX_VOICE_BYTES : mediaKind === 'photo' ? MAX_PHOTO_BYTES : MAX_BYTES)) return { ok: false, code: 'TOO_LARGE' };
        const kind = mediaKind === 'photo' ? sniffImage(buf) : sniff(buf);
        if (!kind) return { ok: false, code: 'BAD_FORMAT' };
        if (mediaKind === 'video' && kind.ext === 'ogg') return { ok: false, code: 'BAD_FORMAT' };
        // голос отдаётся как audio/*, видео — как video/*
        if (mediaKind === 'voice') kind.mime = 'audio/' + kind.ext;
        const id = 'vm_' + crypto.randomBytes(16).toString('hex');
        const d = mediaKind === 'photo' ? 0 : Math.max(1, Math.min(MAX_SEC[mediaKind], Math.round(Number(dur) || 0))) || 1;
        await this.fs.writeFile(path.join(this.dir, id + '.' + kind.ext), buf, { mode: 0o640 });
        this.items[id] = { owner: ownerId, kind: mediaKind, ext: kind.ext, mime: kind.mime, size: buf.length, dur: d, time: this.now() };
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
    check(id, ownerId, kind = 'video') {
        const it = typeof id === 'string' && ID_RE.test(id) ? this.items[id] : null;
        return it && it.owner === ownerId && (it.kind || 'video') === kind ? { ok: true, dur: it.dur } : { ok: false };
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

module.exports = { MediaStore, sniff, sniffImage, ID_RE, MAX_BYTES };
