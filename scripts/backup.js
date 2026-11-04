'use strict';
// Ручная резервная копия: node scripts/backup.js
// Копирует data/messages.json в data/backups/manual-<время>.json
const fs = require('fs');
const path = require('path');
const dir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const src = path.join(dir, 'messages.json');
if (!fs.existsSync(src)) { console.error('Файл истории не найден:', src); process.exit(1); }
JSON.parse(fs.readFileSync(src, 'utf-8')); // убеждаемся, что файл целый
fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
const dst = path.join(dir, 'backups', `manual-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.copyFileSync(src, dst);
console.log('Копия создана:', dst);
