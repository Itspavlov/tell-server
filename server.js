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
const { PushStore, createPushSender } = require('./src/push');
const { createNotifier } = require('./src/notify');
const { AccountStore } = require('./src/accounts');
const { DmStore } = require('./src/dm');
const { MediaStore } = require('./src/media');
const { GroupStore, AdReactions } = require('./src/groups');
const { ListingStore, dayKey } = require('./src/listings');
const { RequestStore } = require('./src/requests');
const { Inbox } = require('./src/inbox');
const { FavoriteStore } = require('./src/favorites');
const { ReviewStore } = require('./src/reviews');
const { ServiceStore } = require('./src/services');
const { DvizStore } = require('./src/dviz');
const { StatsStore } = require('./src/stats');
const { SearchStore } = require('./src/searches');
const { WeatherStore } = require('./src/weather');
const { InviteStore } = require('./src/invites');
const { ReportStore } = require('./src/reports');

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
    const media = new MediaStore({ dataDir: cfg.dataDir, logger });
    await media.init();
    const dms = new DmStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, media, logger });
    await dms.init();
    const groups = new GroupStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, media, logger });
    await groups.init();
    const adReacts = new AdReactions({ dataDir: cfg.dataDir, logger });
    await adReacts.init();
    // дневной лимит публикаций считает InviteStore (по разделам, с бонусом за друзей); внутренний счётчик объявлений — только страховка
    const listings = new ListingStore({ dataDir: cfg.dataDir, accounts, limits: { ...cfg.limits, dailyListings: 100 }, logger });
    await listings.init();
    const requests = new RequestStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger, dayOf: (ts) => dayKey(ts, cfg.limits.serviceTz) });
    groups.requests = requests;
    await requests.init();
    const inbox = new Inbox({ dataDir: cfg.dataDir, logger });
    await inbox.init();
    const favorites = new FavoriteStore({ dataDir: cfg.dataDir, logger });
    await favorites.init();
    const reviews = new ReviewStore({ dataDir: cfg.dataDir, accounts, dms, logger });
    await reviews.init();
    listings.reviews = reviews;
    const services = new ServiceStore({ dataDir: cfg.dataDir, accounts, logger });
    await services.init();
    const dviz = new DvizStore({ dataDir: cfg.dataDir, accounts, services, logger });
    await dviz.init();
    const stats = new StatsStore({ dataDir: cfg.dataDir, logger });
    await stats.init();
    const searches = new SearchStore({ dataDir: cfg.dataDir, logger });
    await searches.init();
    const weather = new WeatherStore({ dataDir: cfg.dataDir, logger });
    await weather.init();
    const invites = new InviteStore({ dataDir: cfg.dataDir, accounts, limits: cfg.limits, logger });
    await invites.init();

    const reports = new ReportStore({ dataDir: cfg.dataDir, logger, hideAt: cfg.reportHideAt });
    await reports.init();

    const pushStore = new PushStore({ dataDir: cfg.dataDir, logger });
    await pushStore.init();
    const push = createPushSender({ store: pushStore, vapid: cfg.vapid, logger });
    logger.info(`Push-уведомления: ${push.enabled() ? 'включены' : 'выключены (нет ключей VAPID или пакета web-push)'}`);

    const admin = createAdmin({ token: cfg.adminToken, dataDir: cfg.dataDir, logger });
    const limiters = createLimiters(cfg.rates);

    let layer = null; // создаётся ниже, после io
    const server = http.createServer();
    const io = new Server(server, {
        cors: { origin: (origin, cb) => cb(null, !origin || isOriginAllowed(origin, cfg)), methods: ['GET', 'POST'] },
        maxHttpBufferSize: cfg.limits.socketBufferBytes,
        allowRequest: (req, cb) => layer.allowRequest(req, cb)
    });
    const notifier = createNotifier({ io, push, inbox, logger });
    layer = createSocketLayer({ io, cfg, store, accounts, dms, groups, adReacts, limiters, notifier, logger });
    io.on('connection', layer.onConnection);

    const app = createApp({ express, cors, cfg, store, admin, accounts, listings, requests, inbox, favorites, reviews, services, dviz, stats, searches, media, dms, weather, invites, groups, adReacts, reports, limiters, io, push, pushStore, notifier, logger });
    server.on('request', app);

    const sweeper = setInterval(() => Object.values(limiters).forEach(l => l.sweep()), 60_000);
    sweeper.unref();
    const mediaSweeper = setInterval(() => media.sweep().catch(() => {}), 6 * 3600 * 1000);
    mediaSweeper.unref();
    const inviteSweeper = setInterval(() => invites.sweep(), 6 * 3600 * 1000);
    inviteSweeper.unref();
    const requestSweeper = setInterval(() => requests.sweep().catch(() => {}), 6 * 3600 * 1000);
    requestSweeper.unref();
    // раз в 10 минут: сообщаем, что у запроса закончился срок
    const seenFlusher = setInterval(() => accounts.flushSeen().catch(() => {}), 5 * 60 * 1000);
    seenFlusher.unref();
    const expirer = setInterval(() => requests.expireDue().then((list) => list.forEach((x) => notifier.notify([x.ownerId], {
        kind: 'request', title: 'Срок запроса истёк', body: (x.city ? x.city + ': ' : '') + 'можно создать новый запрос', open: 'profile', tag: 'req-exp-' + x.id
    }))).catch(() => {}), 10 * 60 * 1000);
    expirer.unref();
    // погода: сразу при старте и затем раз в 30 минут (сбой источника не мешает работе)
    weather.refresh().catch(() => {});
    const weatherTimer = setInterval(() => weather.refresh().catch(() => {}), 30 * 60 * 1000);
    weatherTimer.unref();

    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, cfg.listenHost, resolve); });
    logger.info(`Tell Server v2 запущен на ${cfg.listenHost}:${cfg.port}. Админ-доступ: ${admin.isEnabled() ? 'включён' : 'ВЫКЛЮЧЕН (ADMIN_TOKEN не задан)'}`);

    let closing = false;
    async function shutdown(signal) {
        if (closing) return;
        closing = true;
        logger.info(`Получен ${signal}, завершаем работу...`);
        const force = setTimeout(() => process.exit(1), 10_000);
        force.unref();
        try {
            io.close();
            await inbox.flush().catch(() => {});
            await stats.flush().catch(() => {});
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
    // Неожиданная ошибка: пишем в журнал и перезапускаемся с сохранением данных, а не остаёмся в неопределённом состоянии.
    process.on('uncaughtException', (e) => { logger.error(`uncaughtException: ${(e && e.stack) || e}`); shutdown('uncaughtException'); });
    // Отклонённый промис одного запроса не должен ронять сервер для всех: фиксируем и работаем дальше.
    process.on('unhandledRejection', (e) => { logger.error(`unhandledRejection: ${(e && e.stack) || e}`); });

    return { server, io, store, cfg };
}

module.exports = { start };

if (require.main === module) {
    start().catch((e) => {
        console.error('Сервер не запущен:', e.message);
        process.exit(1);
    });
}
