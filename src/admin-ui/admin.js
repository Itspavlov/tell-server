'use strict';
// Панель модерации. Весь пользовательский текст выводится через textContent — HTML из чатов не исполняется.
(function () {
    const app = document.getElementById('app');
    const ROOMS = [['housing', 'Жильё · все'], ['housing-apartment', 'Жильё · квартиры'], ['housing-house', 'Жильё · дома'], ['housing-hotel', 'Жильё · отели'], ['housing-room', 'Жильё · комнаты'], ['housing-guest', 'Жильё · гостевые'], ['work', 'Работа'], ['market', 'Продам/Отдам'], ['trips', 'Поездки']];
    // Токен запоминается на этом устройстве (localStorage) на 30 дней — вводить его каждый раз не нужно.
    const KEEP_DAYS = 30;
    function loadToken() {
        try {
            const raw = localStorage.getItem('tell-admin');
            if (raw) { const o = JSON.parse(raw); if (o && o.t && o.exp > Date.now()) return o.t; localStorage.removeItem('tell-admin'); }
            const old = sessionStorage.getItem('tell-admin'); if (old) return old;
        } catch (e) {}
        return '';
    }
    function saveToken(t, keep) {
        try {
            sessionStorage.removeItem('tell-admin'); localStorage.removeItem('tell-admin');
            if (keep) localStorage.setItem('tell-admin', JSON.stringify({ t, exp: Date.now() + KEEP_DAYS * 86400000 }));
            else sessionStorage.setItem('tell-admin', t);
        } catch (e) {}
    }
    function forgetToken() { try { localStorage.removeItem('tell-admin'); sessionStorage.removeItem('tell-admin'); } catch (e) {} }
    let token = loadToken();
    let tab = 'overview', room = 'housing', auto = null, counts = {};

    function el(tag, attrs, ...kids) {
        const n = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (k === 'class') n.className = v;
            else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
            else if (v !== false && v != null) n.setAttribute(k, v);
        }
        for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
        return n;
    }
    const fmt = (ts) => ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    function toast(t) { const n = el('div', { class: 'toast' }, t); document.body.append(n); setTimeout(() => n.remove(), 2200); }
    const safeImg = (s) => typeof s === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s) ? s : '';

    async function api(method, path, body) {
        let res;
        try {
            res = await fetch('/api/admin' + path, {
                method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
                body: body ? JSON.stringify(body) : undefined
            });
        } catch (e) { throw new Error('Нет связи с сервером'); }
        if (res.status === 401) { logout('Неверный токен или сессия закончилась'); throw new Error('Неверный токен'); }
        if (res.status === 429) throw new Error('Слишком много запросов. Подождите немного.');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || data.code || data.error || 'Ошибка ' + res.status);
        return data;
    }
    // удаление комнаты живёт по старому адресу
    async function apiRoot(method, path) {
        const res = await fetch(path, { method, headers: { Authorization: 'Bearer ' + token } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Ошибка ' + res.status);
        return data;
    }

    function logout(msg) {
        token = ''; forgetToken();
        stopAuto(); renderLogin(typeof msg === 'string' ? msg : '');
    }
    function stopAuto() { if (auto) { clearInterval(auto); auto = null; } }

    function renderLogin(msg) {
        const inp = el('input', { type: 'password', placeholder: 'ADMIN_TOKEN', autocomplete: 'off' });
        const keep = el('input', { type: 'checkbox', checked: 'checked' });
        const err = el('div', { class: 'err' }, msg);
        const go = async () => {
            token = inp.value.trim(); if (!token) return;
            try { await api('GET', '/overview'); saveToken(token, keep.checked); renderShell(); }
            catch (e) { token = ''; err.textContent = e.message; }
        };
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        app.replaceChildren(el('div', { class: 'login' }, el('div', { class: 'card login-card' },
            el('div', { class: 'logo' }, 'YG'), el('h1', {}, 'YuGi YuGi — модерация'),
            el('p', { class: 'mut' }, 'Введите токен администратора один раз — дальше панель откроется сама.'),
            inp, el('label', { class: 'check' }, keep, ' Запомнить на этом устройстве (30 дней)'), err,
            el('button', { class: 'btn ok wide', onclick: go }, 'Войти'))));
        inp.focus();
    }

    // подтверждение вместо системного confirm()
    function sure(text, okLabel) {
        return new Promise((resolve) => {
            const done = (v) => { back.remove(); resolve(v); };
            const back = el('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) done(false); } },
                el('div', { class: 'modal' }, el('p', {}, text),
                    el('div', { class: 'actions end' }, el('button', { class: 'btn', onclick: () => done(false) }, 'Отмена'),
                        el('button', { class: 'btn bad', onclick: () => done(true) }, okLabel || 'Подтвердить'))));
            document.body.append(back);
        });
    }
    async function guarded(text, fn, okMsg, reload, okLabel) { if (await sure(text, okLabel)) await act(fn, okMsg, reload); }

    // Вход «глазами пользователя»: короткая сессия без личной переписки
    async function asUser(name) {
        if (!(await sure('Открыть приложение как «' + name + '»? Это режим поддержки на 30 минут: можно смотреть профиль, объявления и запросы, но личная переписка и уведомления закрыты. Действие записывается в журнал.', 'Открыть'))) return;
        const w = window.open('', '_blank');
        try {
            const d = await api('POST', '/impersonate', { name });
            const url = location.origin + '/#support=' + d.token + '&n=' + encodeURIComponent(d.user.name) + '&i=' + encodeURIComponent(d.user.id) + (d.user.verified ? '&v=1' : '');
            if (w) w.location.href = url; else location.href = url;
        } catch (e) { if (w) w.close(); toast(e.message); }
    }

    const NAV = [
        ['Главное', [['overview', 'Обзор']]],
        ['Люди', [['verify', 'Верификация'], ['users', 'Пользователи'], ['reports', 'Жалобы']]],
        ['Контент', [['listings', 'Объявления'], ['requests', 'Ищу / Предлагаю'], ['services', 'Развлечения'], ['dviz', 'Курортный движ'], ['reviews', 'Отзывы'], ['chats', 'Чаты']]],
        ['Сайт', [['afisha', 'Афиша'], ['weather', 'Погода']]],
        ['Система', [['audit', 'Журнал']]]
    ];
    const BADGE = { verify: 'verify', reports: 'reports' };

    function renderShell() {
        const body = el('div', { id: 'body' });
        const nav = el('nav', { class: 'nav' });
        for (const [group, items] of NAV) {
            nav.append(el('div', { class: 'nav-group' }, group));
            for (const [id, label] of items) {
                const n = counts[BADGE[id]];
                nav.append(el('button', { class: 'nav-item' + (tab === id ? ' on' : ''), 'data-id': id, onclick: () => { tab = id; stopAuto(); renderShell(); } },
                    label, n ? el('span', { class: 'badge' }, n) : null));
            }
        }
        const title = (NAV.flatMap(g => g[1]).find(x => x[0] === tab) || [0, ''])[1];
        app.replaceChildren(el('div', { class: 'layout' },
            el('aside', { class: 'side' }, el('div', { class: 'brand' }, el('span', { class: 'logo' }, 'YG'), el('b', {}, 'Модерация')), nav,
                el('button', { class: 'btn ghost wide', onclick: () => logout() }, 'Выйти')),
            el('main', { class: 'main' }, el('h2', { class: 'page-title' }, title), body)));
        const views = { overview: vOverview, verify: vVerify, users: vUsers, chats: vChats, listings: vListings, requests: vRequests, dviz: vDviz, reports: vReports, reviews: vReviews, services: vServices, afisha: vAfisha, weather: vWeather, audit: vAudit };
        run(body, views[tab]);
        refreshCounts();
        const on = nav.querySelector('.nav-item.on'); if (on && on.scrollIntoView) on.scrollIntoView({ inline: 'center', block: 'nearest' });
    }
    // бейджи в меню считаются отдельно, чтобы видеть новое, не открывая вкладку
    async function refreshCounts() {
        try {
            const [v, r, cr] = await Promise.all([api('GET', '/verify-requests'), api('GET', '/reports'), api('GET', '/content-reports')]);
            const nv = v.requests.length, nr = r.reports.length + cr.reports.length;
            if (nv !== counts.verify || nr !== counts.reports) {
                counts.verify = nv; counts.reports = nr;
                renderBadges();
            }
        } catch (e) { /* не критично */ }
    }
    function renderBadges() {
        document.querySelectorAll('.nav-item').forEach((b) => {
            const old = b.querySelector('.badge'); if (old) old.remove();
            const n = counts[BADGE[b.dataset.id]];
            if (n) b.append(el('span', { class: 'badge' }, n));
        });
    }

    async function run(body, fn) {
        body.replaceChildren(el('p', { class: 'mut' }, 'Загружаю...'));
        try { await fn(body); } catch (e) { body.replaceChildren(el('p', { class: 'err' }, e.message)); }
    }
    async function act(fn, okMsg, reload) {
        try { await fn(); if (okMsg) toast(okMsg); if (reload) renderShell(); } catch (e) { toast(e.message); }
    }

    const empty = (t) => el('div', { class: 'empty' }, t);
    const initial = (n) => el('span', { class: 'ava' }, (String(n || '?').trim()[0] || '?').toUpperCase());

    // ---------- Обзор ----------
    async function vOverview(body) {
        const d = await api('GET', '/overview');
        const st = (n, t, cls) => el('div', { class: 'card stat ' + (cls || '') }, el('b', {}, n), el('span', { class: 'mut' }, t));
        const u = d.users || {};
        body.replaceChildren(
            el('h3', { class: 'sec' }, 'Люди'),
            el('div', { class: 'stats' }, st(u.users != null ? u.users : '—', 'пользователей'), st(u.verified != null ? u.verified : '—', 'проверенных хозяев'),
                st(u.requests != null ? u.requests : '—', 'заявок на проверку', u.requests ? 'hot' : ''), st(u.banned != null ? u.banned : '—', 'заблокировано')),
            el('h3', { class: 'sec' }, 'Контент'),
            el('div', { class: 'stats' }, st(d.listings, 'объявлений')),
            el('h3', { class: 'sec' }, 'Сообщения в общих чатах'),
            el('div', { class: 'stats' }, ...ROOMS.map(([id, n]) => st(d.rooms[id] || 0, n))),
            el('p', { class: 'mut' }, 'Личные сообщения и группы здесь не показываются намеренно — это переписка пользователей.'));
    }

    // ---------- Верификация ----------
    async function vVerify(body) {
        const d = await api('GET', '/verify-requests');
        counts.verify = d.requests.length; renderBadges();
        if (!d.requests.length) { body.replaceChildren(empty('Заявок на проверку нет')); return; }
        body.replaceChildren(...d.requests.map(r => el('div', { class: 'card item' }, initial(r.name),
            el('div', { class: 'grow' }, el('div', { class: 'head' }, el('b', {}, r.name), el('span', { class: 'mut' }, fmt(r.time))), el('div', { class: 'msg' }, r.note)),
            el('div', { class: 'actions' },
                el('button', { class: 'btn ok', onclick: () => act(() => api('POST', '/verify', { name: r.name, verified: true }), 'Подтверждён: ' + r.name, true) }, 'Подтвердить'),
                el('button', { class: 'btn bad', onclick: () => guarded('Отклонить заявку ' + r.name + '?', () => api('POST', '/verify-reject', { name: r.name }), 'Отклонено', true, 'Отклонить') }, 'Отклонить')))));
    }

    // ---------- Пользователи ----------
    async function vUsers(body) {
        const q = el('input', { type: 'text', placeholder: 'Поиск по имени' });
        const list = el('div');
        const load = async () => {
            const d = await api('GET', '/users?q=' + encodeURIComponent(q.value));
            list.replaceChildren(...(d.users.length ? d.users.map(u => el('div', { class: 'card item' }, initial(u.name),
                el('div', { class: 'grow' },
                    el('div', { class: 'head' }, el('b', {}, u.name), u.verified ? el('span', { class: 'pill ok' }, 'проверенный') : null, u.banned ? el('span', { class: 'pill bad' }, 'заблокирован') : null),
                    el('div', { class: 'mut' }, 'с ' + fmt(u.created))),
                el('div', { class: 'actions' },
                    el('button', { class: 'btn acc', onclick: () => asUser(u.name) }, 'Войти как'),
                    el('button', { class: 'btn', onclick: () => act(async () => { await api('POST', '/verify', { name: u.name, verified: !u.verified }); await load(); }, u.verified ? 'Статус снят' : 'Подтверждён') }, u.verified ? 'Снять проверку жилья' : 'Проверить жильё'),
                    el('button', { class: 'btn', onclick: () => act(async () => { await api('POST', '/verify', { name: u.name, verified: !(u.verifs && u.verifs.trips), kind: 'trips' }); await load(); }, 'Готово') }, u.verifs && u.verifs.trips ? 'Снять проверку водителя' : 'Проверить водителя'),
                    el('button', { class: 'btn', onclick: () => act(async () => { await api('POST', '/verify', { name: u.name, verified: !(u.verifs && u.verifs.services), kind: 'services' }); await load(); }, 'Готово') }, u.verifs && u.verifs.services ? 'Снять проверку развлечений' : 'Проверить развлечения'),
                    el('button', { class: 'btn ' + (u.banned ? '' : 'bad'), onclick: async () => { if (u.banned || await sure('Заблокировать ' + u.name + '? Он будет разлогинен и не сможет войти.', 'Заблокировать')) act(async () => { await api('POST', '/ban', { name: u.name, banned: !u.banned }); await load(); }, u.banned ? 'Разблокирован' : 'Заблокирован'); } }, u.banned ? 'Разблокировать' : 'Заблокировать'),
                    el('button', { class: 'btn', onclick: () => guarded('Удалить ВСЕ сообщения «' + u.name + '» во всех общих чатах?', async () => { const r = await api('POST', '/purge-user', { name: u.name }); toast('Удалено сообщений: ' + r.removed); }, '', false, 'Стереть') }, 'Стереть сообщения')))) : [empty('Никого не нашлось')]));
        };
        q.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
        body.replaceChildren(el('div', { class: 'bar' }, q, el('button', { class: 'btn', onclick: load }, 'Найти')), list);
        await load();
    }

    // ---------- Чаты ----------
    async function vChats(body) {
        const sel = el('select', {}, ...ROOMS.map(([id, n]) => el('option', { value: id, selected: id === room }, n)));
        const list = el('div');
        const chk = el('input', { type: 'checkbox' });
        const load = async () => {
            room = sel.value;
            const d = await api('GET', '/messages/' + room + '?limit=100');
            list.replaceChildren(...(d.messages.length ? d.messages.slice().reverse().map(m => {
                const img = safeImg(m.image);
                return el('div', { class: 'card item' }, initial(m.user),
                    el('div', { class: 'grow' }, el('div', { class: 'head' }, el('b', {}, m.user), el('span', { class: 'mut' }, fmt(m.time))),
                        m.text ? el('div', { class: 'msg' }, m.text) : null, img ? el('img', { src: img, alt: '' }) : null),
                    el('div', { class: 'actions' },
                        el('button', { class: 'btn bad', onclick: () => act(async () => { await api('DELETE', '/messages/' + room + '/' + encodeURIComponent(m.id)); await load(); }, 'Удалено') }, 'Удалить'),
                        el('button', { class: 'btn', title: 'Удалить все сообщения этого автора и заблокировать', onclick: () => guarded('Стереть ВСЕ сообщения «' + m.user + '» и заблокировать, если это аккаунт?', async () => { await api('POST', '/purge-user', { name: m.user }); await api('POST', '/ban', { name: m.user, banned: true }).catch(() => {}); await load(); }, 'Автор вычищен', false, 'Стереть и заблокировать') }, 'Спамер')));
            }) : [empty('Сообщений нет')]));
        };
        sel.addEventListener('change', load);
        chk.addEventListener('change', () => { stopAuto(); if (chk.checked) auto = setInterval(() => load().catch(() => {}), 8000); });
        body.replaceChildren(el('div', { class: 'bar' }, sel, el('button', { class: 'btn', onclick: load }, 'Обновить'),
            el('label', { class: 'check' }, chk, ' авто (8 с)'),
            el('span', { class: 'grow' }),
            el('button', { class: 'btn bad', onclick: () => guarded('Очистить ВСЮ комнату «' + sel.value + '»? Это нельзя отменить.', async () => { await apiRoot('DELETE', '/api/messages/' + sel.value); await load(); }, 'Комната очищена', false, 'Очистить') }, 'Очистить комнату')), list);
        await load();
    }

    // ---------- Объявления ----------
    async function vListings(body) {
        const d = await api('GET', '/listings');
        const q = el('input', { type: 'text', placeholder: 'Поиск: название, хозяин, адрес' });
        const list = el('div');
        const draw = () => {
            const t = q.value.trim().toLowerCase();
            const rows = d.listings.filter(l => !t || [l.title, l.ownerName, l.location, l.phone].some(x => String(x || '').toLowerCase().includes(t)));
            list.replaceChildren(...(rows.length ? rows.map(l => {
                const img = safeImg(l.thumb);
                return el('div', { class: 'card item' }, img ? el('img', { class: 'thumb', src: img, alt: '' }) : el('div', { class: 'thumb' }),
                    el('div', { class: 'grow' }, el('b', {}, l.title || '(без названия)'), el('div', {}, l.price || ''), el('div', { class: 'mut' }, l.location || ''),
                        el('div', { class: 'mut' }, 'Хозяин: ' + l.ownerName + (l.phone ? ' · ' + l.phone : '') + ' · ' + fmt(l.created) + ' · фото: ' + l.photos)),
                    el('div', { class: 'actions' },
                        el('button', { class: 'btn acc', onclick: () => asUser(l.ownerName) }, 'Войти как'),
                        el('button', { class: 'btn bad', onclick: () => guarded('Удалить объявление «' + (l.title || '') + '»?', () => api('DELETE', '/listings/' + encodeURIComponent(l.id)), 'Удалено', true, 'Удалить') }, 'Удалить'),
                        el('button', { class: 'btn', onclick: () => guarded('Заблокировать «' + l.ownerName + '» и снять проверку?', async () => { await api('POST', '/verify', { name: l.ownerName, verified: false }); await api('POST', '/ban', { name: l.ownerName, banned: true }); }, 'Хозяин заблокирован', false, 'Заблокировать') }, 'Заблокировать хозяина')));
            }) : [empty(d.listings.length ? 'Ничего не нашлось' : 'Объявлений нет')]));
        };
        q.addEventListener('input', draw);
        body.replaceChildren(el('div', { class: 'bar' }, q, el('span', { class: 'mut' }, 'Всего: ' + d.listings.length)), list);
        draw();
    }

    // ---------- Запросы «Ищу / Предлагаю» ----------
    const SECTIONS = { housing: 'Жильё', work: 'Работа', trips: 'Попутчики', services: 'Развлечения' };
    const CATS = { apartment: 'Квартира', house: 'Дом', hotel: 'Отель', room: 'Комната', guest: 'Гостевой дом' };
    const money = (n) => n ? Number(n).toLocaleString('ru-RU') + ' ₽' : '';
    async function vRequests(body) {
        const d = await api('GET', '/requests');
        let sec = '';
        const q = el('input', { type: 'text', placeholder: 'Поиск: автор, город, текст' });
        const chips = el('div', { class: 'chips' });
        const list = el('div');
        const draw = () => {
            const t = q.value.trim().toLowerCase();
            chips.replaceChildren(...[['', 'Все'], ...Object.entries(SECTIONS)].map(([id, n]) =>
                el('button', { class: 'chip' + (sec === id ? ' on' : ''), onclick: () => { sec = id; draw(); } }, n)));
            const rows = d.requests.filter(r => (!sec || r.section === sec) && (!t || [r.ownerName, r.city, r.text, r.title, r.district].some(x => String(x || '').toLowerCase().includes(t))));
            list.replaceChildren(...(rows.length ? rows.map(r => {
                const what = r.title || CATS[r.category] || r.category || '';
                const meta = [r.city, r.district, r.dateFrom ? r.dateFrom + (r.dateTo ? ' — ' + r.dateTo : '') : '', r.guests ? r.guests + ' гост.' : '', money(r.budget)].filter(Boolean).join(' · ');
                return el('div', { class: 'card item' }, initial(r.ownerName),
                    el('div', { class: 'grow' },
                        el('div', { class: 'head' }, el('b', {}, r.ownerName), el('span', { class: 'pill ' + (r.kind === 'offer' ? 'ok' : '') }, r.kind === 'offer' ? 'Предлагает' : 'Ищет'),
                            el('span', { class: 'pill' }, SECTIONS[r.section] || r.section),
                            r.status !== 'active' ? el('span', { class: 'pill bad' }, r.status === 'expired' ? 'истёк' : r.status) : null),
                        el('div', {}, what), meta ? el('div', { class: 'mut' }, meta) : null,
                        r.text ? el('div', { class: 'msg' }, r.text) : null,
                        el('div', { class: 'mut' }, fmt(r.created) + (r.offers ? ' · предложений: ' + r.offers : ''))),
                    el('div', { class: 'actions' },
                        el('button', { class: 'btn acc', onclick: () => asUser(r.ownerName) }, 'Войти как'),
                        el('button', { class: 'btn bad', onclick: () => guarded('Удалить карточку «' + (what || 'запрос') + '» автора ' + r.ownerName + '? Автор получит уведомление.', () => api('DELETE', '/requests/' + encodeURIComponent(r.id)), 'Карточка удалена', true, 'Удалить') }, 'Удалить')));
            }) : [empty(d.requests.length ? 'Ничего не нашлось' : 'Карточек «Ищу» пока нет')]));
        };
        q.addEventListener('input', draw);
        body.replaceChildren(el('div', { class: 'bar' }, q, el('span', { class: 'mut' }, 'Всего: ' + d.requests.length)), chips, list);
        draw();
    }

    // ---------- Жалобы: на материалы (объявления, услуги, движ, запросы, сообщения, профили) и на личные сообщения ----------
    const REASONS = { spam: 'Спам', scam: 'Мошенничество', abuse: 'Оскорбления', adult: 'Неприемлемое', other: 'Другое' };
    const KIND_RU = { listing: 'Объявление', request: 'Запрос «Ищу»', dviz: 'Движ', service: 'Услуга', review: 'Отзыв', message: 'Сообщение в комнате', user: 'Профиль' };
    async function vReports(body) {
        const [d, c] = await Promise.all([api('GET', '/reports'), api('GET', '/content-reports')]);
        counts.reports = d.reports.length + c.reports.length; renderBadges();
        if (!d.reports.length && !c.reports.length) { body.replaceChildren(empty('Новых жалоб нет')); return; }
        const content = c.reports.map(r => el('div', { class: 'card item top' },
            el('div', { class: 'grow' },
                el('div', { class: 'head' }, el('b', {}, (KIND_RU[r.kind] || r.kind) + (r.ownerName ? ' · ' + r.ownerName : '')), el('span', { class: 'pill bad' }, REASONS[r.reason] || r.reason), r.hidden ? el('span', { class: 'pill bad' }, 'скрыто автоматически · ' + r.openCount + ' жалоб') : (r.openCount > 1 ? el('span', { class: 'pill' }, r.openCount + ' жалоб') : null), el('span', { class: 'mut' }, fmt(r.time))),
                r.title ? el('div', { class: 'msg' }, r.title) : null,
                r.text ? el('div', { class: 'msg' }, 'Комментарий: ' + r.text) : null,
                el('div', { class: 'mut gap' }, 'Пожаловался: ' + r.reporterName + ' · id: ' + r.targetId)),
            el('div', { class: 'actions' },
                r.ownerName ? el('button', { class: 'btn bad', onclick: () => guarded('Заблокировать «' + r.ownerName + '»?', () => api('POST', '/ban', { name: r.ownerName, banned: true }), 'Заблокирован', false, 'Заблокировать') }, 'Заблокировать автора') : null,
                el('button', { class: 'btn ok', onclick: () => act(() => api('POST', '/content-reports/' + encodeURIComponent(r.id) + '/close', { note: 'разобрано' }), 'Жалоба закрыта', true) }, 'Закрыть'))));
        const dm = d.reports.map(r => el('div', { class: 'card item top' },
            el('div', { class: 'grow' },
                el('div', { class: 'head' }, el('b', {}, r.reporter + ' → ' + r.target), el('span', { class: 'pill bad' }, REASONS[r.reason] || r.reason), el('span', { class: 'mut' }, fmt(r.time))),
                r.text ? el('div', { class: 'msg' }, r.text) : null,
                el('div', { class: 'mut gap' }, 'Последние сообщения диалога:'),
                ...r.messages.map(m => el('div', { class: 'msg' }, (m.from === 'reporter' ? r.reporter : r.target) + ': ' + m.text))),
            el('div', { class: 'actions' },
                el('button', { class: 'btn bad', onclick: () => guarded('Заблокировать «' + r.target + '»?', () => api('POST', '/ban', { name: r.target, banned: true }), 'Заблокирован', false, 'Заблокировать') }, 'Заблокировать'),
                el('button', { class: 'btn ok', onclick: () => act(() => api('POST', '/reports/' + encodeURIComponent(r.id) + '/close'), 'Жалоба закрыта', true) }, 'Закрыть'))));
        body.replaceChildren(...content, ...dm);
    }

    // ---------- Отзывы ----------
    async function vReviews(body) {
        const d = await api('GET', '/reviews');
        if (!d.reviews.length) { body.replaceChildren(empty('Отзывов пока нет')); return; }
        body.replaceChildren(...d.reviews.map(r => el('div', { class: 'card item' }, initial(r.author),
            el('div', { class: 'grow' },
                el('div', { class: 'head' }, el('b', {}, r.author), el('span', { class: 'pill' }, '★ ' + r.rating), el('span', { class: 'mut' }, fmt(r.created))),
                r.text ? el('div', { class: 'msg' }, r.text) : null,
                r.reply ? el('div', { class: 'mut gap' }, 'Ответ хозяина: ' + r.reply) : null),
            el('div', { class: 'actions' },
                el('button', { class: 'btn bad', onclick: () => guarded('Удалить отзыв?', () => api('DELETE', '/reviews/' + encodeURIComponent(r.id)), 'Отзыв удалён', true, 'Удалить') }, 'Удалить')))));
    }

    // ---------- Развлечения ----------
    async function vServices(body) {
        const d = await api('GET', '/services');
        if (!d.services.length) { body.replaceChildren(empty('Карточек развлечений пока нет')); return; }
        body.replaceChildren(...d.services.map(x => el('div', { class: 'card item' }, initial(x.ownerName),
            el('div', { class: 'grow' },
                el('div', { class: 'head' }, el('b', {}, x.title), el('span', { class: 'pill' }, x.price ? x.price + ' ₽' : 'без цены')),
                el('div', { class: 'mut' }, x.ownerName + ' · ' + (x.city || '') + ' · фото: ' + x.photos + ' · ' + fmt(x.created))),
            el('div', { class: 'actions' },
                el('button', { class: 'btn acc', onclick: () => asUser(x.ownerName) }, 'Войти как'),
                el('button', { class: 'btn bad', onclick: () => guarded('Удалить карточку развлечения?', () => api('DELETE', '/services/' + encodeURIComponent(x.id)), 'Карточка удалена', true, 'Удалить') }, 'Удалить')))));
    }

    // ---------- Курортный движ ----------
    async function vDviz(body) {
        const d = await api('GET', '/dviz');
        if (!d.events.length) { body.replaceChildren(empty('Движей пока нет')); return; }
        body.replaceChildren(...d.events.map(x => el('div', { class: 'card item' }, initial(x.ownerName),
            el('div', { class: 'grow' },
                el('div', { class: 'head' }, el('b', {}, x.title), x.active ? el('span', { class: 'pill ok' }, 'идёт') : el('span', { class: 'pill' }, 'закончился')),
                el('div', { class: 'mut' }, [x.ownerName, x.when ? x.when.replace('T', ' ') : 'без времени', x.place].filter(Boolean).join(' · ')),
                el('div', { class: 'mut' }, 'Откликов: ' + x.joins + ' · комментариев: ' + x.comments + ' · фото: ' + x.photos + ' · ' + fmt(x.created))),
            el('div', { class: 'actions' },
                el('button', { class: 'btn acc', onclick: () => asUser(x.ownerName) }, 'Войти как'),
                el('button', { class: 'btn bad', onclick: () => guarded('Удалить движ «' + x.title + '» автора ' + x.ownerName + '?', () => api('DELETE', '/dviz/' + encodeURIComponent(x.id)), 'Движ удалён', true, 'Удалить') }, 'Удалить')))));
    }

    // ---------- Афиша: главная, «Чем заняться сегодня?» ----------
    const AF_KIND = { event: 'Событие', story: 'История', place: 'Интересное место', news: 'Новость' };
    const AF_ICON = { event: '🎤', story: '📖', place: '🏞️', news: '📰' };
    const readFile = (f) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(f); });
    const loadImg = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
    // из выбранного файла делаем две картинки: целую (для открытой записи) и обложку под плитку на главной (в ту же пропорцию, что у плитки)
    async function makeImages(file) {
        const img = await loadImg(await readFile(file));
        const draw = (w, h, sx, sy, sw, sh, q) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, sx, sy, sw, sh, 0, 0, w, h); return c.toDataURL('image/jpeg', q); };
        let image = '';
        for (const [side, q] of [[1280, 0.82], [1100, 0.75], [900, 0.7], [720, 0.65]]) {
            const k = Math.min(1, side / Math.max(img.width, img.height));
            image = draw(Math.round(img.width * k), Math.round(img.height * k), 0, 0, img.width, img.height, q);
            if (image.length <= 440000) break;
        }
        let thumb = '';
        for (const [w, h, q] of [[440, 630, 0.74], [400, 570, 0.68], [360, 515, 0.62], [300, 430, 0.58]]) {
            const k = Math.max(w / img.width, h / img.height), sw = w / k, sh = h / k;
            thumb = draw(w, h, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, q);
            if (thumb.length <= 106000) break;
        }
        return { image, thumb };
    }
    async function vAfisha(body) {
        let d = await api('GET', '/afisha');
        let editing = null, pic = undefined;      // pic: undefined — картинку не трогаем; {image, thumb} — новая; '' — убрать
        const f = {};
        const field = (label, node) => el('label', { class: 'af-field' }, el('span', { class: 'mut' }, label), node);
        f.kind = el('select', {}, ...Object.entries(AF_KIND).map(([v, t]) => el('option', { value: v }, t)));
        f.title = el('input', { type: 'text', maxlength: '80', placeholder: 'Например: Концерт на набережной' });
        f.text = el('textarea', { rows: '5', maxlength: '2000', placeholder: 'Что будет, где, во сколько. Для истории и места — сам рассказ.' });
        f.when = el('input', { type: 'datetime-local' });
        f.place = el('input', { type: 'text', maxlength: '120', placeholder: 'Где: набережная, водопад, смотровая' });
        f.lat = el('input', { type: 'number', step: 'any', placeholder: 'Широта, например 44.3625' });
        f.lng = el('input', { type: 'number', step: 'any', placeholder: 'Долгота, например 38.5265' });
        f.link = el('input', { type: 'text', maxlength: '300', placeholder: 'Ссылка на билеты или подробности (https://…)' });
        f.pinned = el('input', { type: 'checkbox' });
        f.file = el('input', { type: 'file', accept: 'image/*' });
        f.prev = el('div', { class: 'af-prev' });
        const paintPrev = () => {
            const src = pic && pic.thumb ? pic.thumb : (editing && pic === undefined ? editing.thumb : '');
            f.prev.replaceChildren(...(safeImg(src) ? [el('img', { src, alt: '' }), el('button', { class: 'btn', onclick: () => { pic = ''; paintPrev(); } }, 'Убрать фото')] : [el('span', { class: 'mut' }, 'Фото не выбрано')]));
        };
        f.file.addEventListener('change', async () => {
            const file = f.file.files && f.file.files[0]; f.file.value = '';
            if (!file) return;
            try { pic = await makeImages(file); paintPrev(); } catch (e) { toast('Не удалось обработать фото'); }
        });
        const syncKind = () => { whenBox.style.display = f.kind.value === 'event' ? '' : 'none'; };
        f.kind.addEventListener('change', syncKind);
        const whenBox = field('Дата и время (по Москве)', f.when);
        const reset = () => { editing = null; pic = undefined; f.kind.value = 'event'; for (const k of ['title', 'text', 'when', 'place', 'lat', 'lng', 'link']) f[k].value = ''; f.pinned.checked = false; syncKind(); paintPrev(); head.textContent = 'Новая запись'; saveBtn.textContent = 'Добавить в афишу'; cancelBtn.style.display = 'none'; };
        const fill = (it) => {
            editing = it; pic = undefined;
            f.kind.value = it.kind; f.title.value = it.title; f.text.value = it.text; f.when.value = it.when || ''; f.place.value = it.place || '';
            f.lat.value = it.coords ? it.coords[0] : ''; f.lng.value = it.coords ? it.coords[1] : ''; f.link.value = it.link || ''; f.pinned.checked = !!it.pinned;
            syncKind(); paintPrev(); head.textContent = 'Правка записи'; saveBtn.textContent = 'Сохранить'; cancelBtn.style.display = ''; window.scrollTo({ top: 0, behavior: 'smooth' });
        };
        const head = el('b', {}, 'Новая запись');
        const saveBtn = el('button', { class: 'btn ok', onclick: () => act(async () => {
            const lat = f.lat.value.trim(), lng = f.lng.value.trim();
            const payload = { ...(editing ? { id: editing.id } : {}), kind: f.kind.value, title: f.title.value, text: f.text.value, place: f.place.value, link: f.link.value.trim(),
                when: f.kind.value === 'event' ? f.when.value : '', pinned: f.pinned.checked, coords: lat && lng ? [Number(lat), Number(lng)] : null };
            if (pic === '') payload.image = '';
            else if (pic) { payload.image = pic.image; payload.thumb = pic.thumb; }
            await api('POST', '/afisha', payload);
            reset(); draw(await api('GET', '/afisha'));
        }, 'Сохранено') }, 'Добавить в афишу');
        const cancelBtn = el('button', { class: 'btn', style: 'display:none', onclick: reset }, 'Отменить правку');
        const form = el('div', { class: 'card af-form' }, head,
            el('div', { class: 'af-row' }, field('Вид', f.kind), whenBox), field('Заголовок', f.title), field('Текст', f.text), field('Место', f.place),
            el('div', { class: 'af-row' }, field('Широта (необязательно)', f.lat), field('Долгота (необязательно)', f.lng)),
            field('Ссылка', f.link), field('Фото', el('div', {}, f.file, f.prev)),
            el('label', { class: 'af-check' }, f.pinned, el('span', {}, ' Закрепить сверху (всегда первым на главной)')),
            el('div', { class: 'actions' }, saveBtn, cancelBtn),
            el('p', { class: 'mut' }, 'Запись сразу появится на главной в «Чем заняться сегодня?». Событие с датой пропадёт само через 6 часов после начала, история и место остаются, пока вы их не уберёте. Координаты можно взять в Яндекс Картах: клик правой кнопкой по точке.'));
        const list = el('div', { id: 'afList' });
        function draw(data) {
            d = data;
            list.replaceChildren(...(d.items.length ? d.items.map(x => el('div', { class: 'card item' },
                safeImg(x.thumb) ? el('img', { class: 'af-thumb', src: x.thumb, alt: '' }) : el('span', { class: 'ava' }, AF_ICON[x.kind] || '•'),
                el('div', { class: 'grow' },
                    el('div', { class: 'head' }, el('b', {}, x.title), el('span', { class: 'pill' + (x.expired ? '' : ' ok') }, x.expired ? 'прошло' : AF_KIND[x.kind]), x.pinned ? el('span', { class: 'pill' }, '📌 закреплено') : null),
                    el('div', { class: 'mut' }, [x.when ? x.when.replace('T', ' ') : '', x.place].filter(Boolean).join(' · ') || 'без даты'),
                    el('div', { class: 'mut' }, (x.text || '').slice(0, 140))),
                el('div', { class: 'actions' },
                    el('button', { class: 'btn acc', onclick: () => act(async () => fill((await api('GET', '/afisha/' + encodeURIComponent(x.id))).item)) }, 'Править'),
                    el('button', { class: 'btn', onclick: () => act(async () => { await api('POST', '/afisha', { id: x.id, kind: x.kind, title: x.title, text: x.text, place: x.place, link: x.link, when: x.when, coords: x.coords, pinned: !x.pinned }); draw(await api('GET', '/afisha')); }, x.pinned ? 'Откреплено' : 'Закреплено') }, x.pinned ? 'Открепить' : 'Закрепить'),
                    el('button', { class: 'btn bad', onclick: () => guarded('Убрать «' + x.title + '» из афиши?', async () => { await api('DELETE', '/afisha/' + encodeURIComponent(x.id)); draw(await api('GET', '/afisha')); }, 'Убрано', false, 'Убрать') }, 'Убрать')))) : [empty('В афише пока пусто. Добавьте первое событие, историю или интересное место.')]));
        }
        syncKind(); paintPrev(); draw(d);
        body.replaceChildren(form, el('h3', { class: 'af-h' }, 'Сейчас в афише'), list);
    }

    // ---------- Погода в шапке ----------
    async function vWeather(body) {
        const d = await api('GET', '/weather');
        const MODE = [['auto', 'Автоматически'], ['manual', 'Вручную'], ['off', 'Не показывать']];
        const draw = (data) => {
            const card = (kind, title, hint) => {
                const s = data[kind];
                const sel = el('select', {}, ...MODE.map(([v, t]) => el('option', { value: v, ...(s.mode === v ? { selected: 'selected' } : {}) }, t)));
                const inp = el('input', { type: 'number', step: '0.5', min: data.limits[kind][0], max: data.limits[kind][1], value: s.manual == null ? '' : s.manual, placeholder: '°C' });
                const sync = () => { inp.disabled = sel.value !== 'manual'; };
                sel.addEventListener('change', sync); sync();
                const autoTxt = s.auto == null ? 'автоматика пока не получила данные' : 'автоматика: ' + s.auto + '°, ' + fmt(s.autoAt);
                return el('div', { class: 'card' },
                    el('div', { class: 'head' }, el('b', {}, title), el('span', { class: 'pill' }, s.shown == null ? 'не показывается' : 'на сайте: ' + Math.round(s.shown) + '°')),
                    el('div', { class: 'mut' }, hint), el('div', { class: 'mut' }, autoTxt),
                    el('div', { class: 'form-row' }, sel, inp,
                        el('button', { class: 'btn ok', onclick: () => act(async () => {
                            const payload = { [kind]: { mode: sel.value, ...(sel.value === 'manual' ? { manual: inp.value } : {}) } };
                            draw(await api('POST', '/weather', payload));
                        }, 'Сохранено') }, 'Сохранить')));
            };
            body.replaceChildren(
                el('div', { class: 'two' }, card('air', 'Температура воздуха', 'Архипо-Осиповка, показывается в шапке главной.'),
                    card('water', 'Температура воды', 'Море у Архипо-Осиповки.')),
                el('div', { class: 'actions' }, el('button', { class: 'btn', onclick: () => act(async () => draw(await api('POST', '/weather/refresh')), 'Данные обновлены') }, 'Обновить автоданные сейчас')),
                el('p', { class: 'mut' }, 'Автоматические значения берутся из Open-Meteo раз в 30 минут. Для воды это модельные данные, поэтому при необходимости задайте значение вручную. Ручное значение остаётся, пока вы его не смените.'));
        };
        draw(d);
    }

    // ---------- Журнал ----------
    const ACTION = { afisha_add: 'Афиша: добавлено', afisha_edit: 'Афиша: изменено', afisha_delete: 'Афиша: убрано', impersonate: 'Вход как пользователь', delete_request: 'Удалён запрос «Ищу»', delete_dviz: 'Удалён движ', delete_listing: 'Удалено объявление', ban: 'Блокировка', verify: 'Проверка хозяина', set_weather: 'Погода' };
    async function vAudit(body) {
        const d = await api('GET', '/audit?limit=200');
        if (!d.entries.length) { body.replaceChildren(empty('Журнал пуст')); return; }
        body.replaceChildren(...d.entries.map(e => el('div', { class: 'card' }, el('div', { class: 'head' }, el('b', {}, ACTION[e.action] || e.action), el('span', { class: 'mut' }, (e.ts || '').replace('T', ' ').slice(0, 19))),
            el('pre', {}, JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'action' && k !== 'ts')))))));
    }

    if (token) { api('GET', '/overview').then(() => renderShell()).catch((e) => { if (token) renderLogin(e.message === 'Нет связи с сервером' ? e.message : ''); }); } else renderLogin('');
})();
