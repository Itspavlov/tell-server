'use strict';
// ============================================
// TELL SERVER v2 (этап 1: защита)
// Запуск: npm start
// Прежняя версия сохранена в legacy/server.v1.js (откат).
// ============================================

const http = require('http');
const { loadConfig, isOriginAllowed } = require('./src/config');
const { MessageStore } = require('./src/store');
const { createAdmin } = require('./src/admin');
const { createLimiters } = require('./src/rateLimit');
const { createApp } = require('./src/http');
const { createSocketLayer } = require('./src/sockets');
const { AccountStore } = require('./src/accounts');
const { DmStore } = require('./src/dm');
const { GroupStore, AdReactions } = require('./src/groups');
const { ListingStore } = require('./src/listings');

async function start(env = process.env, logger = console) {
    const cfg = loadConfig(env);
    const express = require('express');
    const cors = require('cors');
    const { Server } = require('socket.io');

    const store = new MessageStore({
        dataDir: cfg.dataDir, rooms: cfg.rooms,
        roomCap: cfg.limits.roomCap, maxStoreBytes: cfg.limits.maxStoreBytes, logger
    });
    await store.init(); // при повреждённом файле бросит ошибку и сервер не стартует

    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger });
    await accounts.init();
    const dms = new DmStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger });
    await dms.init();
    const groups = new GroupStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger });
    await groups.init();
    const adReacts = new AdReactions({ dataDir: cfg.dataDir, logger });
    await adReacts.init();
    const listings = new ListingStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger });
    await listings.init();

    const admin = createAdmin({ token: cfg.adminToken, dataDir: cfg.dataDir, logger });
    const limiters = createLimiters(cfg.rates);

    let layer = null; // создаётся ниже, после io
    const server = http.createServer();
    const io = new Server(server, {
        cors: { origin: (origin, cb) => cb(null, !origin || isOriginAllowed(origin, cfg)), methods: ['GET', 'POST'] },
        maxHttpBufferSize: cfg.limits.socketBufferBytes,
        allowRequest: (req, cb) => layer.allowRequest(req, cb)
    });
    layer = createSocketLayer({ io, cfg, store, accounts, dms, groups, adReacts, limiters, logger });
    io.on('connection', layer.onConnection);

    const app = createApp({ express, cors, cfg, store, admin, accounts, listings, limiters, io, logger });
    server.on('request', app);

    const sweeper = setInterval(() => Object.values(limiters).forEach(l => l.sweep()), 60_000);
    sweeper.unref();

    await new Promise((resolve) => server.listen(cfg.port, resolve));
    logger.info(`Tell Server v2 запущен на порту ${cfg.port}. Админ-доступ: ${admin.isEnabled() ? 'включён' : 'ВЫКЛЮЧЕН (ADMIN_TOKEN не задан)'}`);

    let closing = false;
    async function shutdown(signal) {
        if (closing) return;
        closing = true;
        logger.info(`Получен ${signal}, завершаем работу...`);
        const force = setTimeout(() => process.exit(1), 10_000);
        force.unref();
        try {
            io.close();
            await store.close();
            logger.info('История сохранена. До свидания.');
            process.exit(0);
        } catch (e) {
            logger.error(`Ошибка при завершении: ${e.message}`);
            process.exit(1);
        }
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    return { server, io, store, cfg };
}

module.exports = { start };

if (require.main === module) {
    start().catch((e) => {
        console.error('Сервер не запущен:', e.message);
        process.exit(1);
    });
}
