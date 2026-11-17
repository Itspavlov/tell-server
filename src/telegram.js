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

function createTelegram({ token = '', chatId = '', secret = '', fetchImpl = (typeof fetch === 'function' ? fetch : null), logger = console, base = 'https://api.telegram.org', siteUrl = 'https://yugiyugi.ru' } = {}) {
    const site = String(siteUrl || '').replace(/\/+$/, '');
    const on = !!(token && chatId && secret && fetchImpl);
    async function call(method, body) {
        if (!on) return null;
        try {
            const r = await fetchImpl(`${base}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            return await r.json();
        } catch (e) { logger.warn?.(`telegram ${method}: ${e && e.message}`); return null; }
    }
    async function callPhoto(fields, dataUrl) {
        if (!on) return null;
        try {
            const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+\/=]+)$/.exec(String(dataUrl || ''));
            if (!m || typeof FormData === 'undefined' || typeof Blob === 'undefined') return null;
            const fd = new FormData();
            for (const [k, v] of Object.entries(fields)) fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
            fd.append('photo', new Blob([Buffer.from(m[2], 'base64')], { type: m[1] }), 'photo.jpg');
            const r = await fetchImpl(`${base}/bot${token}/sendPhoto`, { method: 'POST', body: fd });
            return await r.json();
        } catch (e) { logger.warn?.(`telegram sendPhoto: ${e && e.message}`); return null; }
    }
    return {
        enabled: () => on,
        chatId: () => String(chatId),
        checkSecret(given) {
            const a = Buffer.from(String(given || '')), b = Buffer.from(String(secret));
            return on && a.length === b.length && crypto.timingSafeEqual(a, b);
        },
        // ссылка, по которой модератор откроет материал на сайте
        linkFor(rep, ctx = {}) {
            if (!site) return '';
            if (rep.kind === 'listing') return `${site}/?open=${encodeURIComponent('listing:' + rep.targetId)}`;
            if (rep.kind === 'request' && ['work', 'trips'].includes(ctx.section)) return `${site}/?open=room:${ctx.section}`;
            if (rep.kind === 'request') return `${site}/?open=room:housing`;
            if (rep.kind === 'service') return `${site}/?open=room:services`;
            return site + '/';
        },
        adminLink() { return site ? site + '/admin' : ''; },
        reportText(rep, count, link) {
            return `🚩 <b>Жалоба: ${esc(KIND[rep.kind] || rep.kind)}</b> (${esc(REASON[rep.reason] || rep.reason)})\n`
                + `«${esc(rep.title || '—')}»\nАвтор: ${esc(rep.ownerName || '—')}\nЖалуется: ${esc(rep.reporterName)}${rep.text ? '\nТекст: ' + esc(rep.text) : ''}\n`
                + `Жалоб на это: ${count || 1}`
                + (link ? `\n\n<a href="${esc(link)}">Открыть на сайте</a>` : '') + (site ? ` · <a href="${esc(site + '/admin')}">Админка</a>` : '');
        },
        notifyReport(rep, count, ctx) {
            if (!on) return Promise.resolve(null);
            const del = ['listing', 'request', 'service', 'dviz'].includes(rep.kind);
            const row = [];
            if (del) row.push({ text: '🗑 Удалить', callback_data: 'del:' + rep.id });
            if (rep.ownerName && rep.kind !== 'user') row.push({ text: '⛔ Бан автора', callback_data: 'ban:' + rep.id });
            else if (rep.kind === 'user') row.push({ text: '⛔ Бан', callback_data: 'ban:' + rep.id });
            row.push({ text: '✅ Оставить', callback_data: 'keep:' + rep.id });
            const link = this.linkFor(rep, ctx);
            const rows = [row];
            if (link) rows.unshift([{ text: '🔗 Открыть на сайте', url: link }]);
            return call('sendMessage', { chat_id: chatId, text: this.reportText(rep, count, link), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: rows } });
        },
        // Первая карточка нового автора: модератору приходит текст (и фото) с кнопками «Одобрить / Удалить / Бан»
        async notifyHold(h) {
            if (!on) return null;
            const secName = { work: 'Работа', trips: 'Поездки' }[h.section] || '';
            const kindWord = h.kind === 'service' ? 'услуга (Развлечения)' : h.kind === 'request' ? (h.offer ? 'объявление' : 'запрос') + ' (' + secName + ')' : 'объявление (Жильё)';
            const text = `🆕 <b>Новая публикация на проверке: ${esc(kindWord)}</b>\n«${esc(h.title)}»${h.price ? '\nЦена: ' + esc(h.price) : ''}\n${h.text ? esc(String(h.text).slice(0, 350)) + '\n' : ''}Автор: ${esc(h.ownerName)}\nПока вы не одобрите, её никто, кроме автора, не видит.`;
            const k = h.kind === 'service' ? 's' : h.kind === 'request' ? 'r' : 'l';
            const reply_markup = { inline_keyboard: [[{ text: '✅ Одобрить', callback_data: `hok:${k}:${h.id}` }, { text: '🗑 Удалить', callback_data: `hno:${k}:${h.id}` }], [{ text: '⛔ Удалить и забанить', callback_data: `hban:${k}:${h.id}` }]] };
            if (h.photo) {
                const r = await callPhoto({ chat_id: String(chatId), caption: text.slice(0, 1000), parse_mode: 'HTML', reply_markup }, h.photo);
                if (r && r.ok) return r;
            }
            return call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup });
        },
        answer(id, text) { return call('answerCallbackQuery', { callback_query_id: id, text: String(text || '').slice(0, 190) }); },
        finish(msg, note) {
            if (!msg) return Promise.resolve(null);
            if (msg.photo) return call('editMessageCaption', { chat_id: msg.chat.id, message_id: msg.message_id, caption: String(msg.caption || '').slice(0, 900) + '\n\n' + note, reply_markup: { inline_keyboard: [] } });
            return call('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: String(msg.text || '').slice(0, 3500) + '\n\n' + note, reply_markup: { inline_keyboard: [] } });
        }
    };
}

module.exports = { createTelegram };
