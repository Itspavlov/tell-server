#!/usr/bin/env bash
# Установка и обновление Tell на Debian/Ubuntu.
#
# Перед запуском должны лежать файлы (загружаются с вашего компьютера через scp):
#   /root/tell-server.zip  — код сервера
#   /root/tell-site.zip    — код сайта (по желанию; без него сайт не обновляется)
#
# Запуск:   bash /root/setup.sh ВАШ-ДОМЕН        (боевой режим, потом отдельно HTTPS)
#           bash /root/setup.sh 129.101.98.108   (только проверка по IP, без HTTPS — НЕ для людей)
#
# Скрипт можно запускать повторно: данные (/var/lib/tell) и секреты (/etc/tell/env) он не трогает.
set -euo pipefail

DOMAIN="${1:-}"
[ -n "$DOMAIN" ] || { echo "Укажите домен или IP: bash setup.sh ВАШ-ДОМЕН"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "Запустите от root"; exit 1; }

APP=/opt/tell-server
SITE=/var/www/tell
DATA=/var/lib/tell
ENVF=/etc/tell/env

if [[ "$DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  SCHEME=http
  echo "ВНИМАНИЕ: режим по IP без HTTPS. Пароли идут открытым текстом — только для проверки."
else
  SCHEME=https
fi

command -v unzip >/dev/null || apt-get -y install unzip >/dev/null

echo "== Пользователь и каталоги"
id tell >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin tell
mkdir -p "$APP" "$SITE" "$DATA" /etc/tell /var/backups/tell
chown -R tell:tell "$DATA"
chmod 750 "$DATA"

echo "== Код сервера"
[ -f /root/tell-server.zip ] || { echo "Нет /root/tell-server.zip"; exit 1; }
rm -rf /root/_srv && mkdir /root/_srv && unzip -q /root/tell-server.zip -d /root/_srv
rm -rf "$APP"/* && cp -a /root/_srv/. "$APP"/ && rm -rf /root/_srv
( cd "$APP" && npm install --omit=dev --no-audit --no-fund --silent )
chown -R root:root "$APP"
chmod -R go-w "$APP"

echo "== Настройки ($ENVF)"
if [ ! -f "$ENVF" ]; then
  TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  cat > "$ENVF" <<ENV
NODE_ENV=production
PORT=3000
DATA_DIR=$DATA
TRUST_PROXY=true
ALLOWED_ORIGINS=$SCHEME://$DOMAIN
ADMIN_TOKEN=$TOKEN
ENV
  chmod 600 "$ENVF"
  echo "Создан новый ADMIN_TOKEN (показать: grep ADMIN_TOKEN $ENVF)"
else
  # адрес сайта обновляем, секреты не трогаем
  sed -i "s#^ALLOWED_ORIGINS=.*#ALLOWED_ORIGINS=$SCHEME://$DOMAIN#" "$ENVF"
  echo "Настройки уже есть, ADMIN_TOKEN сохранён"
fi

# Ключи для push-уведомлений (создаются один раз; менять нельзя — подписки устройств перестанут работать)
if ! grep -q '^VAPID_PUBLIC_KEY=' "$ENVF"; then
  ( cd "$APP" && node scripts/vapid.js ) >> "$ENVF"
  echo "Созданы VAPID-ключи для push"
fi
sed -i '/^VAPID_SUBJECT=/d' "$ENVF"
if [ "$SCHEME" = "https" ]; then echo "VAPID_SUBJECT=https://$DOMAIN" >> "$ENVF"; else echo "VAPID_SUBJECT=mailto:admin@example.com" >> "$ENVF"; fi

echo "== Служба tell"
cat > /etc/systemd/system/tell.service <<UNIT
[Unit]
Description=Tell server
After=network.target

[Service]
User=tell
Group=tell
WorkingDirectory=$APP
EnvironmentFile=$ENVF
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA
MemoryMax=700M

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable tell >/dev/null 2>&1
systemctl restart tell

echo "== Сайт"
if [ -f /root/tell-site.zip ]; then
  rm -rf /root/_site && mkdir /root/_site && unzip -q /root/tell-site.zip -d /root/_site
  rm -rf "$SITE"/* && cp -a /root/_site/. "$SITE"/ && rm -rf /root/_site
  chown -R root:root "$SITE"; chmod -R a+rX "$SITE"
  [ -d "$SITE/vendor" ] || echo "ПРЕДУПРЕЖДЕНИЕ: в сайте нет папки vendor/ — иконки, карта и чат не заработают. Закоммитьте vendor/ и пришлите сайт заново."
else
  echo "Нет /root/tell-site.zip — сайт не обновлён"
fi

echo "== nginx"
mkdir -p /etc/nginx/snippets
cat > /etc/nginx/conf.d/tell-hardening.conf <<'HARD'
server_tokens off;
limit_req_zone $binary_remote_addr zone=tell_api:10m rate=20r/s;
limit_conn_zone $binary_remote_addr zone=tell_conn:10m;
limit_req_status 429;
limit_conn_status 429;
client_header_timeout 15s;
client_body_timeout 30s;
send_timeout 30s;
HARD
cat > /etc/nginx/snippets/tell-headers.conf <<'HDR'
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy no-referrer always;
add_header X-Frame-Options SAMEORIGIN always;
add_header Strict-Transport-Security "max-age=15552000" always;
add_header Permissions-Policy "camera=(self), microphone=(self), geolocation=(self)" always;
HDR
cat > /etc/nginx/sites-available/tell <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    root $SITE;
    index index.html;
    client_max_body_size 8m;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    include snippets/tell-headers.conf;

    location /socket.io/ {
        limit_conn tell_conn 100;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }

    location ~ ^/(api|admin|healthz|readyz)(/|\$) {
        limit_req zone=tell_api burst=60 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /vendor/ {
        expires 30d;
        add_header Cache-Control "public, immutable";
        include snippets/tell-headers.conf;
    }

    location / {
        add_header Cache-Control "no-cache";
        include snippets/tell-headers.conf;
        try_files \$uri \$uri/ =404;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/tell /etc/nginx/sites-enabled/tell
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "== Ежедневная копия данных (хранится 14 дней)"
if [ -x /usr/local/bin/tell-backup.sh ]; then echo "уже настроена расширенная копия (tell-backup.sh), пропускаю"; else
cat > /etc/cron.d/tell-backup <<CRON
17 4 * * * root tar -czf /var/backups/tell/tell-\$(date +\%F).tgz -C $DATA . && find /var/backups/tell -name 'tell-*.tgz' -mtime +14 -delete
CRON
chmod 644 /etc/cron.d/tell-backup
fi

echo "== Проверка"
sleep 2
systemctl is-active tell
curl -fsS "http://127.0.0.1:3000/healthz" && echo
echo
echo "Готово."
if [ "$SCHEME" = https ]; then
  echo "Дальше (когда домен уже указывает на этот сервер):  certbot --nginx -d $DOMAIN"
fi
echo "Журнал сервера:  journalctl -u tell -n 50 --no-pager"
