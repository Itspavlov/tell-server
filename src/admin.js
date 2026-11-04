'use strict';
// ============================================
// Административный доступ.
//
// Секрет ADMIN_TOKEN хранится ТОЛЬКО в переменной окружения на сервере.
// Если переменная не задана — все админские операции отключены.
// Токен не попадает ни в клиентский код, ни в логи, ни в Git.
// Каждое административное действие пишется в журнал аудита.
// ============================================

const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');

function createAdmin({ token, dataDir, logger = console, fsImpl = fsp, now = Date.now }) {
    const auditFile = path.join(dataDir, 'audit.log');
    const tokenHash = token ? crypto.createHash('sha256').update(token).digest() : null;

    function isEnabled() { return !!tokenHash; }

    // Сравнение за постоянное время (хеши одинаковой длины)
    function authorize(authHeader) {
        if (!tokenHash) return false;
        if (typeof authHeader !== 'string') return false;
        const m = /^Bearer (.+)$/.exec(authHeader);
        if (!m || m[1].length > 512) return false;
        const given = crypto.createHash('sha256').update(m[1]).digest();
        return crypto.timingSafeEqual(given, tokenHash);
    }

    // Запись в журнал. Токены и содержимое сообщений сюда не попадают.
    async function audit(action, details = {}) {
        const entry = { ts: new Date(now()).toISOString(), action, ...details };
        logger.info?.(`AUDIT ${JSON.stringify(entry)}`);
        try {
            await fsImpl.mkdir(dataDir, { recursive: true });
            await fsImpl.appendFile(auditFile, JSON.stringify(entry) + '\n', 'utf-8');
        } catch (e) {
            logger.error?.(`Не удалось записать журнал аудита: ${e.code || e.message}`);
        }
    }

    // Последние записи журнала (новые сверху)
    async function readAudit(limit = 100) {
        let text = '';
        try { text = await fsImpl.readFile(auditFile, 'utf-8'); } catch (e) { return []; }
        const out = [];
        for (const line of text.split('\n').slice(-Math.min(limit, 500)).reverse()) {
            if (!line) continue;
            try { out.push(JSON.parse(line)); } catch (e) { /* битая строка пропускается */ }
        }
        return out;
    }

    return { isEnabled, authorize, audit, auditFile, readAudit };
}

module.exports = { createAdmin };
