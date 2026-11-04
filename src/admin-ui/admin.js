'use strict';
// Панель модерации. Весь пользовательский текст выводится через textContent — HTML из чатов не исполняется.
(function () {
    const app = document.getElementById('app');
    const ROOMS = [['housing', 'Жильё'], ['work', 'Работа'], ['market', 'Продам/Отдам'], ['trips', 'Поездки']];
    let token = '';
    try { token = sessionStorage.getItem('tell-admin') || ''; } catch (e) {}
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
        token = ''; try { sessionStorage.removeItem('tell-admin'); } catch (e) {}
        stopAuto(); renderLogin(typeof msg === 'string' ? msg : '');
    }
    function stopAuto() { if (auto) { clearInterval(auto); auto = null; } }

    function renderLogin(msg) {
        const inp = el('input', { type: 'password', placeholder: 'ADMIN_TOKEN', autocomplete: 'off' });
        const err = el('div', { class: 'err' }, msg);
        const go = async () => {
            token = inp.value.trim(); if (!token) return;
            try { await api('GET', '/overview'); try { sessionStorage.setItem('tell-admin', token); } catch (e) {} renderShell(); }
            catch (e) { token = ''; err.textContent = e.message; }
        };
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        app.replaceChildren(el('div', { class: 'wrap login' }, el('div', { class: 'card' },
            el('h1', {}, 'Tell — модерация'), el('p', { class: 'mut' }, 'Введите токен администратора. Он хранится только в этой вкладке и пропадает при её закрытии.'),
            inp, err, el('button', { class: 'btn ok', onclick: go }, 'Войти'))));
        inp.focus();
    }

    function renderShell() {
        const body = el('div', { id: 'body' });
        const tabs = el('div', { class: 'tabs' });
        const defs = [['overview', 'Обзор'], ['requests', 'Заявки'], ['users', 'Пользователи'], ['chats', 'Чаты'], ['listings', 'Объявления'], ['audit', 'Журнал']];
        for (const [id, label] of defs) {
            tabs.append(el('button', { class: 'tab' + (tab === id ? ' on' : ''), onclick: () => { tab = id; stopAuto(); renderShell(); } },
                label, id === 'requests' && counts.requests ? el('span', { class: 'badge' }, counts.requests) : null));
        }
        app.replaceChildren(el('div', { class: 'wrap' },
            el('div', { class: 'top' }, el('h1', {}, 'Tell — модерация'), el('button', { class: 'btn ghost', onclick: logout }, 'Выйти')), tabs, body));
        const views = { overview: vOverview, requests: vRequests, users: vUsers, chats: vChats, listings: vListings, audit: vAudit };
        run(body, views[tab]);
    }

    async function run(body, fn) {
        body.replaceChildren(el('p', { class: 'mut' }, 'Загружаю...'));
        try { await fn(body); } catch (e) { body.replaceChildren(el('p', { class: 'err' }, e.message)); }
    }
    async function act(fn, okMsg, reload) {
        try { await fn(); if (okMsg) toast(okMsg); if (reload) renderShell(); } catch (e) { toast(e.message); }
    }

    // ---------- Обзор ----------
    async function vOverview(body) {
        const d = await api('GET', '/overview');
        counts.requests = d.users ? d.users.requests : 0;
        const st = (n, t) => el('div', { class: 'card stat' }, el('b', {}, n), el('span', { class: 'mut' }, t));
        body.replaceChildren(el('div', { class: 'stats' },
            st(d.users ? d.users.users : '—', 'пользователей'), st(d.users ? d.users.verified : '—', 'проверенных хозяев'),
            st(d.users ? d.users.requests : '—', 'заявок ждут'), st(d.users ? d.users.banned : '—', 'заблокировано'),
            st(d.listings, 'объявлений'), ...ROOMS.map(([id, n]) => st(d.rooms[id] || 0, 'сообщений: ' + n))),
            el('p', { class: 'mut' }, 'Личные сообщения и группы здесь не показываются намеренно — это переписка пользователей.'));
    }

    // ---------- Заявки ----------
    async function vRequests(body) {
        const d = await api('GET', '/verify-requests');
        counts.requests = d.requests.length;
        if (!d.requests.length) { body.replaceChildren(el('p', { class: 'mut' }, 'Заявок нет')); return; }
        body.replaceChildren(...d.requests.map(r => el('div', { class: 'card' }, el('div', { class: 'row' },
            el('div', {}, el('b', {}, r.name), el('span', { class: 'mut' }, '  ' + fmt(r.time)), el('div', { class: 'msg' }, r.note)),
            el('div', { class: 'actions' },
                el('button', { class: 'btn ok', onclick: () => act(() => api('POST', '/verify', { name: r.name, verified: true }), 'Подтверждён: ' + r.name, true) }, 'Подтвердить'),
                el('button', { class: 'btn bad', onclick: () => confirm('Отклонить заявку ' + r.name + '?') && act(() => api('POST', '/verify-reject', { name: r.name }), 'Отклонено', true) }, 'Отклонить'))))));
    }

    // ---------- Пользователи ----------
    async function vUsers(body) {
        const q = el('input', { type: 'text', placeholder: 'Поиск по имени' });
        const list = el('div');
        const load = async () => {
            const d = await api('GET', '/users?q=' + encodeURIComponent(q.value));
            list.replaceChildren(...(d.users.length ? d.users.map(u => el('div', { class: 'card' }, el('div', { class: 'row' },
                el('div', {}, el('b', {}, u.name), u.verified ? el('span', { class: 'pill ok' }, 'проверенный') : null, u.banned ? el('span', { class: 'pill bad' }, 'заблокирован') : null,
                    el('div', { class: 'mut' }, 'с ' + fmt(u.created))),
                el('div', { class: 'actions' },
                    el('button', { class: 'btn', onclick: () => act(async () => { await api('POST', '/verify', { name: u.name, verified: !u.verified }); await load(); }, u.verified ? 'Статус снят' : 'Подтверждён') }, u.verified ? 'Снять проверку' : 'Проверить'),
                    el('button', { class: 'btn ' + (u.banned ? '' : 'bad'), onclick: () => (u.banned || confirm('Заблокировать ' + u.name + '? Он будет разлогинен и не сможет войти.')) && act(async () => { await api('POST', '/ban', { name: u.name, banned: !u.banned }); await load(); }, u.banned ? 'Разблокирован' : 'Заблокирован') }, u.banned ? 'Разблокировать' : 'Заблокировать'),
                    el('button', { class: 'btn', onclick: () => confirm('Удалить ВСЕ сообщения «' + u.name + '» во всех чатах?') && act(async () => { const r = await api('POST', '/purge-user', { name: u.name }); toast('Удалено сообщений: ' + r.removed); }) }, 'Стереть сообщения'))))) : [el('p', { class: 'mut' }, 'Никого не нашлось')]));
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
                return el('div', { class: 'card' }, el('div', { class: 'row' },
                    el('div', { style: 'min-width:0;flex:1' }, el('b', {}, m.user), el('span', { class: 'mut' }, '  ' + fmt(m.time)),
                        m.text ? el('div', { class: 'msg' }, m.text) : null, img ? el('img', { src: img, alt: '' }) : null),
                    el('div', { class: 'actions' },
                        el('button', { class: 'btn bad', onclick: () => act(async () => { await api('DELETE', '/messages/' + room + '/' + encodeURIComponent(m.id)); await load(); }, 'Удалено') }, 'Удалить'),
                        el('button', { class: 'btn', title: 'Удалить все сообщения этого автора', onclick: () => confirm('Стереть ВСЕ сообщения «' + m.user + '» и заблокировать, если это аккаунт?') && act(async () => { await api('POST', '/purge-user', { name: m.user }); await api('POST', '/ban', { name: m.user, banned: true }).catch(() => {}); await load(); }, 'Автор вычищен') }, 'Спамер'))));
            }) : [el('p', { class: 'mut' }, 'Сообщений нет')]));
        };
        sel.addEventListener('change', load);
        chk.addEventListener('change', () => { stopAuto(); if (chk.checked) auto = setInterval(() => load().catch(() => {}), 8000); });
        body.replaceChildren(el('div', { class: 'bar' }, sel, el('button', { class: 'btn', onclick: load }, 'Обновить'),
            el('label', { class: 'mut' }, chk, ' авто (8 с)'),
            el('button', { class: 'btn bad', onclick: () => confirm('Очистить ВСЮ комнату «' + sel.value + '»? Это нельзя отменить.') && act(async () => { await apiRoot('DELETE', '/api/messages/' + sel.value); await load(); }, 'Комната очищена') }, 'Очистить комнату')), list);
        await load();
    }

    // ---------- Объявления ----------
    async function vListings(body) {
        const d = await api('GET', '/listings');
        if (!d.listings.length) { body.replaceChildren(el('p', { class: 'mut' }, 'Объявлений нет')); return; }
        body.replaceChildren(...d.listings.map(l => {
            const img = safeImg(l.thumb);
            return el('div', { class: 'card ad' }, img ? el('img', { class: 'thumb', src: img, alt: '' }) : el('div', { class: 'thumb' }),
                el('div', {}, el('b', {}, l.title || '(без названия)'), el('div', {}, l.price || ''), el('div', { class: 'mut' }, l.location || ''),
                    el('div', { class: 'mut' }, 'Хозяин: ' + l.ownerName + (l.phone ? ' · ' + l.phone : '') + ' · ' + fmt(l.created) + ' · фото: ' + l.photos),
                    el('div', { class: 'actions', style: 'margin-top:8px' },
                        el('button', { class: 'btn bad', onclick: () => confirm('Удалить объявление «' + (l.title || '') + '»?') && act(() => api('DELETE', '/listings/' + encodeURIComponent(l.id)), 'Удалено', true) }, 'Удалить'),
                        el('button', { class: 'btn', onclick: () => confirm('Заблокировать «' + l.ownerName + '» и снять проверку?') && act(async () => { await api('POST', '/verify', { name: l.ownerName, verified: false }); await api('POST', '/ban', { name: l.ownerName, banned: true }); }, 'Хозяин заблокирован') }, 'Заблокировать хозяина'))));
        }));
    }

    // ---------- Журнал ----------
    async function vAudit(body) {
        const d = await api('GET', '/audit?limit=200');
        if (!d.entries.length) { body.replaceChildren(el('p', { class: 'mut' }, 'Журнал пуст')); return; }
        body.replaceChildren(...d.entries.map(e => el('div', { class: 'card' }, el('b', {}, e.action), el('span', { class: 'mut' }, '  ' + (e.ts || '').replace('T', ' ').slice(0, 19)),
            el('pre', {}, JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'action' && k !== 'ts')))))));
    }

    if (token) { api('GET', '/overview').then(() => renderShell()).catch(() => renderLogin('')); } else renderLogin('');
})();
