'use strict';
// Небольшой помощник: JSON-файл с атомарной записью (tmp + fsync + rename).
// Повреждённый файл не затирается — загрузка завершается ошибкой.
const fsp = require('fs').promises;
const path = require('path');

class JsonFile {
    constructor({ file, fsImpl = fsp }) {
        this.file = file;
        this.fs = fsImpl;
        this.chain = Promise.resolve();
    }

    async load(def) {
        await this.fs.mkdir(path.dirname(this.file), { recursive: true });
        let raw;
        try { raw = await this.fs.readFile(this.file, 'utf-8'); }
        catch (e) { if (e.code === 'ENOENT') return def; throw e; }
        if (!raw.trim()) return def;
        try {
            const data = JSON.parse(raw);
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('format');
            // копия на случай проблем (одна, перезаписывается при каждом старте)
            await this.fs.writeFile(this.file + '.bak', raw, 'utf-8').catch(() => {});
            return data;
        } catch (e) {
            const err = new Error(`Файл ${this.file} повреждён. Сервер не запущен, чтобы не затереть данные. Восстановите его из ${path.basename(this.file)}.bak`);
            err.code = 'CORRUPT';
            throw err;
        }
    }

    // Снимок данных делается сразу, запись идёт по очереди
    save(data) {
        const json = JSON.stringify(data);
        const run = this.chain.then(async () => {
            const tmp = this.file + '.tmp';
            const fh = await this.fs.open(tmp, 'w');
            try { await fh.writeFile(json, 'utf-8'); await fh.sync(); } finally { await fh.close(); }
            await this.fs.rename(tmp, this.file);
        });
        this.chain = run.catch(() => {});
        return run;
    }
}

module.exports = { JsonFile };
