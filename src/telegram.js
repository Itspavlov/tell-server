'use strict';
// ============================================
// Telegram для модератора: на каждую жалобу приходит сообщение с кнопками
// «Удалить», «Заблокировать автора», «Оставить». Нажатия приходят вебхуком на /api/tg/<секрет>.
// Выключено, пока не заданы TG_BOT_TOKEN, TG_CHAT_ID и TG_WEBHOOK_SECRET. Нажимать кнопки может только TG_CHAT_ID.
// ============================================

const crypto = require('crypto');

const REASON = { spam: 'спам', scam: 'мошенничество', abuse: 'оскорбления', adult: '18+', other: 'другое' };
const KIND = { listing: 'объявление', request: 'запрос', dviz: 'встреча', service: 'услуга', review: 'отзыв', message: 'сообщение', user: 'профиль' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function createTelegram({ token = '', chatId = '', secret = '', fetchImpl = (typeof fetch === 'function' ? fetch : null), logger = console, base = 'https://api.telegram.org' } = {}) {
    const on = !!(token && chatId && secret && fetchImpl);
    async function call(method, body) {
        if (!on) return null;
        try {
            const r = await fetchImpl(`${base}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            return await r.json();
        } catch (e) { logger.warn?.(`telegram ${method}: ${e && e.message}`); return null; }
    }
    return {
        enabled: () => on,
        chatId: () => String(chatId),
        checkSecret(given) {
            const a = Buffer.from(String(given || '')), b = Buffer.from(String(secret));
            return on && a.length === b.length && crypto.timingSafeEqual(a, b);
        },
        reportText(rep, count) {
            return `🚩 <b>Жалоба: ${esc(KIND[rep.kind] || rep.kind)}</b> (${esc(REASON[rep.reason] || rep.reason)})\n`
                + `«${esc(rep.title || '—')}»\nАвтор: ${esc(rep.ownerName || '—')}\nЖалуется: ${esc(rep.reporterName)}${rep.text ? '\nТекст: ' + esc(rep.text) : ''}\n`
                + `Жалоб на это: ${count || 1}`;
        },
        notifyReport(rep, count) {
            if (!on) return Promise.resolve(null);
            const del = ['listing', 'request', 'service', 'dviz'].includes(rep.kind);
            const row = [];
            if (del) row.push({ text: '🗑 Удалить', callback_data: 'del:' + rep.id });
            if (rep.ownerName && rep.kind !== 'user') row.push({ text: '⛔ Бан автора', callback_data: 'ban:' + rep.id });
            else if (rep.kind === 'user') row.push({ text: '⛔ Бан', callback_data: 'ban:' + rep.id });
            row.push({ text: '✅ Оставить', callback_data: 'keep:' + rep.id });
            return call('sendMessage', { chat_id: chatId, text: this.reportText(rep, count), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [row] } });
        },
        answer(id, text) { return call('answerCallbackQuery', { callback_query_id: id, text: String(text || '').slice(0, 190) }); },
        finish(msg, note) {
            if (!msg) return Promise.resolve(null);
            return call('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: String(msg.text || '').slice(0, 3500) + '\n\n' + note, reply_markup: { inline_keyboard: [] } });
        }
    };
}

module.exports = { createTelegram };
