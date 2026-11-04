'use strict';
// ============================================
// Настройки сервера. Всё берётся из переменных
// окружения, секретов в коде нет.
// ============================================

const path = require('path');

// Единственные комнаты, в которые можно писать (как и раньше)
const ROOMS = ['housing', 'work', 'market', 'trips'];

const DEFAULT_ORIGIN = 'https://gokurort-new.onrender.com';
const DEV_ORIGINS = [
    'http://localhost:3000', 'http://127.0.0.1:3000',
    'http://localhost:5500', 'http://127.0.0.1:5500',   // Live Server в VS Code
    'http://localhost:8080', 'http://127.0.0.1:8080'
];

function parseList(value) {
    return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function normalizeOrigin(o) {
    return String(o).trim().replace(/\/+$/, '').toLowerCase();
}

function intEnv(env, key, def, min, max) {
    const raw = env[key];
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
        throw new Error(`${key} должен быть числом от ${min} до ${max}`);
    }
    return Math.floor(n);
}

function loadConfig(env = process.env) {
    const isProd = env.NODE_ENV === 'production';

    const origins = parseList(env.ALLOWED_ORIGINS).map(normalizeOrigin);
    if (!origins.length) origins.push(DEFAULT_ORIGIN);
    if (!isProd) origins.push(...DEV_ORIGINS);

    const adminToken = env.ADMIN_TOKEN || '';
    if (adminToken && adminToken.length < 32) {
        throw new Error('ADMIN_TOKEN слишком короткий: нужно не менее 32 символов');
    }

    const imageMaxBytes = intEnv(env, 'IMAGE_MAX_BYTES', 1_500_000, 10_000, 5_000_000);

    return Object.freeze({
        port: intEnv(env, 'PORT', 3000, 1, 65535),
        isProd,
        rooms: ROOMS,
        allowedOrigins: Object.freeze([...new Set(origins)]),
        // Запросы без заголовка Origin (curl, тесты). В production по умолчанию запрещены.
        allowNoOrigin: env.ALLOW_NO_ORIGIN === 'true' || (!isProd && env.ALLOW_NO_ORIGIN !== 'false'),
        // Render стоит за прокси: берём IP, который дописал сам прокси
        trustProxy: env.TRUST_PROXY !== 'false',
        dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(__dirname, '..', 'data'),
        adminToken,
        vapid: Object.freeze({ publicKey: env.VAPID_PUBLIC_KEY || '', privateKey: env.VAPID_PRIVATE_KEY || '', subject: env.VAPID_SUBJECT || '' }),

        limits: Object.freeze({
            nameMin: 2,
            nameMax: 24,
            textMax: 1000,
            imageMaxBytes,
            // base64 длиннее исходника на треть + служебный заголовок
            socketBufferBytes: Math.ceil(imageMaxBytes * 4 / 3) + 64 * 1024,
            historyDefault: 100,
            historyMax: 200,
            roomCap: 500,
            maxStoreBytes: intEnv(env, 'MAX_STORE_MB', 150, 10, 2000) * 1024 * 1024,
            maxConnectionsPerIp: 25,
            dupWindowMs: 5000,
            violationLimit: 8,
            maxListingsBytes: intEnv(env, 'MAX_LISTINGS_MB', 100, 5, 1000) * 1024 * 1024
        }),

        rates: Object.freeze({
            msgPerSocket: { windowMs: 10_000, max: 10 },
            msgPerIp: { windowMs: 60_000, max: 60 },
            imgPerIp: { windowMs: 60_000, max: 6 },
            joinPerSocket: { windowMs: 10_000, max: 20 },
            connectPerIp: { windowMs: 60_000, max: 60 },
            httpPerIp: { windowMs: 60_000, max: 120 },
            historyPerIp: { windowMs: 60_000, max: 60 },
            adminPerIp: { windowMs: 60_000, max: 120 },
            adminFail: { windowMs: 900_000, max: 10 },
            reactSocket: { windowMs: 10_000, max: 20 },
            reactIp: { windowMs: 60_000, max: 120 },
            registerIp: { windowMs: 3_600_000, max: 10 },
            loginIp: { windowMs: 60_000, max: 10 },
            loginName: { windowMs: 900_000, max: 10 },
            groupCreate: { windowMs: 3_600_000, max: 10 },
            groupJoin: { windowMs: 60_000, max: 10 },
            groupInvite: { windowMs: 60_000, max: 20 },
            listingSave: { windowMs: 3_600_000, max: 40 },
            verifyRequest: { windowMs: 3_600_000, max: 5 },
            pushSub: { windowMs: 3_600_000, max: 30 }
        })
    });
}

function isOriginAllowed(origin, cfg) {
    if (!origin) return cfg.allowNoOrigin;
    return cfg.allowedOrigins.includes(normalizeOrigin(origin));
}

module.exports = { ROOMS, loadConfig, isOriginAllowed, normalizeOrigin };
