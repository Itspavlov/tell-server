# Tell Server v2 — этап 1 (защита)

Что сделано: закрыто удаление сообщений посторонними, добавлена серверная проверка всех данных, защита от спама, безопасная запись истории, резервные копии.
Что НЕ сделано (отдельные этапы): PostgreSQL, аккаунты, личные сообщения, загрузка фото во внешнее хранилище.

## Что заменить в репозитории tell-server
Новые файлы/папки: `src/`, `scripts/`, `tests/`, `legacy/`, `.env.example`, `.node-version`, `README.md`.
Заменить: `server.js`, `package.json`, `.gitignore`.
Старый сервер сохранён в `legacy/server.v1.js` (для отката).
Файл `data/messages.json` НЕ трогать и не удалять.

## Локальный запуск и проверка
```
npm install
npm test                    # быстрые тесты без сети
npm run test:integration    # тест с настоящим express/socket.io
npm start
```
В PowerShell команды вводите по одной строке.

## Переменные окружения (Render → Environment)
| Имя | Значение |
|---|---|
| NODE_ENV | production |
| ALLOWED_ORIGINS | https://gokurort-new.onrender.com |
| ADMIN_TOKEN | длинный секрет (32+ символов), `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| DATA_DIR | путь к Persistent Disk, например /var/data (если диск подключён) |

Без ADMIN_TOKEN админ-функции полностью выключены (это безопасный режим).
Токен храните только в Render и у себя; в Git и в клиентский код он не попадает.

## Админ-команды (PowerShell)
Очистить комнату:
`Invoke-RestMethod -Method Delete -Uri https://tell-server.onrender.com/api/messages/work -Headers @{Authorization="Bearer ВАШ_ТОКЕН"}`
Скачать копию всей истории:
`Invoke-WebRequest -Uri https://tell-server.onrender.com/api/admin/export -Headers @{Authorization="Bearer ВАШ_ТОКЕН"} -OutFile backup.json`
Журнал действий: `data/audit.log`.

## Безопасный порядок выкладки
1. Перед выкладкой скачайте копию истории (команда export выше — со старого сервера она не работает, поэтому на Render откройте Shell и скопируйте `data/messages.json`, либо хотя бы сделайте `GET /api/messages/<комната>` для каждой комнаты и сохраните ответы).
2. Локально: `npm test`, затем `npm start` и откройте сайт, указав адрес локального сервера.
3. Выкладывайте только после п.2: `git add .`, `git commit -m "server v2"`, `git push origin main`.
4. После деплоя проверьте `/healthz`, `/readyz` и отправку сообщения с сайта.
5. Сначала сервер, потом клиент (сервер совместим со старым клиентом).

## Откат
Render → Deploys → предыдущий деплой → Rollback. Либо в репозитории: `git revert <коммит>`; либо временно запустить `legacy/server.v1.js` (команда start: `node legacy/server.v1.js`).
История: при каждом старте в `data/backups/` создаётся копия (хранятся последние 20). Восстановление: остановить сервер, скопировать нужную копию поверх `data/messages.json`, запустить.

## Важно
Без Persistent Disk Render стирает файлы при каждом пересоздании сервиса — это ограничение хранения в файле, а не новой версии. Для надёжной истории нужен диск или PostgreSQL (этап 3).
Лимиты и IP хранятся в памяти одного процесса: при нескольких инстансах понадобится общее хранилище (Redis).
