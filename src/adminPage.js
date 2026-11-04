'use strict';
// Статические файлы панели модерации (читаются один раз при запуске)
const fs = require('fs');
const path = require('path');
const rd = (f) => fs.readFileSync(path.join(__dirname, 'admin-ui', f), 'utf-8');
module.exports = {
    html: { type: 'text/html; charset=utf-8', body: rd('index.html') },
    js: { type: 'application/javascript; charset=utf-8', body: rd('admin.js') },
    css: { type: 'text/css; charset=utf-8', body: rd('admin.css') }
};
