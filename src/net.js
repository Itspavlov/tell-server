'use strict';
// ============================================
// Определение IP клиента.
// Render ставит перед сервером свой прокси и ДОПИСЫВАЕТ реальный адрес
// в конец X-Forwarded-For. Всё, что клиент вписал сам, стоит левее,
// поэтому берём ПОСЛЕДНЕЕ значение, а не первое (иначе лимиты обходятся
// подделкой заголовка).
// ============================================

function getClientIp(handshake, trustProxy) {
    const remote = (handshake && (handshake.address || handshake.remoteAddress)) || 'unknown';
    if (!trustProxy) return remote;
    const xff = handshake && handshake.headers && handshake.headers['x-forwarded-for'];
    if (typeof xff !== 'string' || !xff.trim()) return remote;
    const parts = xff.split(',').map(s => s.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    return last && last.length <= 64 ? last : remote;
}

module.exports = { getClientIp };
