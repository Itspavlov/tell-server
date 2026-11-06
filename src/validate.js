'use strict';
// ============================================
// Строгая проверка всего, что присылает клиент.
// Клиенту не доверяем ничего: ни имени, ни комнате,
// ни аватару, ни типу картинки.
// ============================================

// управляющие, нулевой ширины и «разворачивающие текст» символы
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.'\-]*$/u;
const RESERVED_PARTS = ['admin', 'moderator', 'support', 'system', 'tellteam', 'админ', 'модератор', 'поддержк', 'система'];
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const IMAGE_RE = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;
const AVATAR_RE = /^[\p{L}\p{N}]$/u;

const MESSAGES = {
    BAD_PAYLOAD: 'Некорректные данные сообщения',
    INVALID_ROOM: 'Такого чата нет',
    INVALID_NAME: 'Имя: от 2 до 24 символов — буквы, цифры, пробел, _ . - \'',
    RESERVED_NAME: 'Это имя зарезервировано, выберите другое',
    TEXT_TOO_LONG: 'Сообщение слишком длинное (максимум 1000 символов)',
    EMPTY_MESSAGE: 'Пустое сообщение',
    IMAGE_INVALID: 'Недопустимое изображение (нужны JPEG, PNG, WebP или GIF)',
    IMAGE_TOO_LARGE: 'Фото слишком большое',
    IMAGE_TYPE_MISMATCH: 'Файл не похож на настоящее изображение',
    NOT_IN_ROOM: 'Соединение восстанавливается. Повторите отправку',
    RATE_LIMITED: 'Слишком часто. Подождите несколько секунд',
    DUPLICATE_TEXT: 'Такое сообщение вы уже отправили',
    STORE_UNAVAILABLE: 'Не удалось сохранить сообщение. Попробуйте ещё раз',
    STORE_FULL: 'Хранилище фото заполнено. Отправьте текст без фото',
    SERVER_ERROR: 'Ошибка сервера. Попробуйте позже',
    BAD_PASSWORD: 'Пароль: от 8 до 72 символов',
    NAME_TAKEN: 'Это имя уже занято. Войдите в аккаунт или выберите другое имя',
    BAD_CREDENTIALS: 'Неверное имя или пароль',
    AUTH_REQUIRED: 'Нужно войти в аккаунт',
    SELF_DM: 'Это ваше собственное объявление',
    NO_CONVERSATION: 'Диалог не найден',
    BAD_REACTION: 'Такой реакции нет',
    MESSAGE_NOT_FOUND: 'Сообщение не найдено',
    TOO_MANY_ACCOUNTS: 'Регистрация временно недоступна',
    NO_GROUP: 'Группа не найдена',
    BAD_GROUP_NAME: 'Название группы: от 2 до 40 символов',
    USER_NOT_FOUND: 'Пользователь с таким именем не зарегистрирован',
    GROUP_FULL: 'В группе уже максимум участников (20)',
    TOO_MANY_GROUPS: 'Слишком много групп (максимум 10)',
    ALREADY_MEMBER: 'Уже в группе',
    BAD_INVITE: 'Приглашение недействительно',
    BAD_LISTING: 'Проверьте поля объявления',
    LISTING_NOT_FOUND: 'Объявление не найдено',
    NOT_OWNER: 'Это не ваше объявление',
    TOO_MANY_LISTINGS: 'Слишком много объявлений (максимум 20)',
    LISTINGS_FULL: 'Хранилище объявлений заполнено',
    DAILY_LIMIT: 'Сегодня вы уже опубликовали максимум объявлений. Новые можно завтра, редактировать старые — без ограничений',
    BAD_REQUEST: 'Проверьте поля запроса: даты, число гостей и бюджет',
    REQUEST_WAIT: 'Подождите перед следующим запросом',
    REQUEST_DUPLICATE: 'Такой запрос у вас уже опубликован',
    TOO_MANY_REQUESTS: 'Слишком много активных запросов (максимум 5). Закройте ненужные',
    REQUEST_NOT_FOUND: 'Запрос не найден',
    BANNED: 'Аккаунт заблокирован модератором',
    NOT_VERIFIED: 'Размещать объявления могут только проверенные хозяева. Подайте заявку на проверку в профиле'
};
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const MSG_ID_RE = /^msg_[A-Za-z0-9_-]{1,60}$/;

function fail(code, extra) {
    return { ok: false, code, message: MESSAGES[code] || MESSAGES.SERVER_ERROR, ...(extra || {}) };
}

function isValidRoom(room, rooms) {
    return typeof room === 'string' && rooms.includes(room);
}

function normalizeName(raw, limits) {
    if (typeof raw !== 'string') return fail('INVALID_NAME');
    const s = raw.normalize('NFC').replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
    if (s.length < limits.nameMin || s.length > limits.nameMax) return fail('INVALID_NAME');
    if (!NAME_RE.test(s)) return fail('INVALID_NAME');
    const flat = s.toLowerCase().replace(/[\s_.'\-]+/g, '');
    if (RESERVED_PARTS.some(p => flat.includes(p))) return fail('RESERVED_NAME');
    return { ok: true, value: s };
}

function normalizeText(raw, max) {
    if (typeof raw !== 'string') return fail('BAD_PAYLOAD');
    const s = raw.normalize('NFC')
        .replace(/\r\n?/g, '\n')
        .replace(CONTROL_RE, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (s.length > max) return fail('TEXT_TOO_LONG');
    return { ok: true, value: s };
}

// Определяем настоящий тип по первым байтам, а не по заявленному
function detectMime(buf) {
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
        buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return 'png';
    if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
    if (buf.length >= 6) {
        const g = buf.toString('ascii', 0, 6);
        if (g === 'GIF87a' || g === 'GIF89a') return 'gif';
    }
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    return null;
}

function validateImage(value, maxBytes) {
    if (typeof value !== 'string') return fail('IMAGE_INVALID');
    // дешёвая проверка длины до тяжёлых операций
    if (value.length > Math.ceil(maxBytes * 4 / 3) + 128) return fail('IMAGE_TOO_LARGE');
    const m = IMAGE_RE.exec(value);
    if (!m) return fail('IMAGE_INVALID');
    const declared = m[1];
    const b64 = m[2];
    if (b64.length % 4 !== 0) return fail('IMAGE_INVALID');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length === 0) return fail('IMAGE_INVALID');
    if (buf.length > maxBytes) return fail('IMAGE_TOO_LARGE');
    if (detectMime(buf) !== declared) return fail('IMAGE_TYPE_MISMATCH');
    return { ok: true, value, bytes: buf.length, mime: declared };
}

// Полная проверка send-message. Возвращает очищенный объект.
function validateSend(data, limits, rooms) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('BAD_PAYLOAD');

    if (!isValidRoom(data.room, rooms)) return fail('INVALID_ROOM');

    const name = normalizeName(data.user, limits);
    if (!name.ok) return name;

    let text = '';
    if (data.text !== undefined && data.text !== null) {
        const t = normalizeText(data.text, limits.textMax);
        if (!t.ok) return t;
        text = t.value;
    }

    let image = null;
    let imageBytes = 0;
    if (data.image !== undefined && data.image !== null && data.image !== '') {
        const img = validateImage(data.image, limits.imageMaxBytes);
        if (!img.ok) return img;
        image = img.value;
        imageBytes = img.bytes;
    }

    if (!text && !image) return fail('EMPTY_MESSAGE');

    let clientId = null;
    if (data.clientId !== undefined && data.clientId !== null) {
        if (typeof data.clientId !== 'string' || !CLIENT_ID_RE.test(data.clientId)) return fail('BAD_PAYLOAD');
        clientId = data.clientId;
    }

    let replyTo = null;
    if (typeof data.replyTo === 'string' && MSG_ID_RE.test(data.replyTo)) replyTo = data.replyTo;

    return { ok: true, value: { room: data.room, user: name.value, text, image, imageBytes, clientId, replyTo } };
}

function validatePassword(pw) {
    if (typeof pw !== 'string' || pw.length < 8 || pw.length > 72 || !pw.trim()) return fail('BAD_PASSWORD');
    return { ok: true, value: pw };
}

// Аватар — только первая буква имени; присланному клиентом аватару не верим
function avatarFor(user) {
    const first = Array.from(String(user || ''))[0] || '?';
    return AVATAR_RE.test(first) ? first.toUpperCase() : '?';
}

module.exports = {
    MESSAGES, fail, isValidRoom, normalizeName, normalizeText,
    validateImage, validateSend, validatePassword, avatarFor, detectMime, IMAGE_RE,
    REACTIONS, CLIENT_ID_RE, MSG_ID_RE
};
