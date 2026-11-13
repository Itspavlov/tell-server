'use strict';
// ============================================
// Отправка писем (коды подтверждения почты и восстановления пароля).
// Без внешних пакетов: короткий SMTP-клиент поверх TLS (порт 465) с входом по логину и паролю.
// Настройки берутся из переменных окружения (см. config.js). Не заданы — письма выключены,
// а приложение продолжает работать: остаётся восстановление по коду.
// ============================================
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const os = require('os');

const CRLF = '\r\n';
const clean = (s) => String(s == null ? '' : s).replace(/[\r\n\u0000]+/g, ' ').trim();
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const encWord = (s) => /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
const addrOnly = (a) => clean(a).replace(/^.*<([^>]+)>.*$/, '$1');

function buildMessage({ from, fromName, to, subject, text, host, now }) {
    const date = new Date(now()).toUTCString().replace('GMT', '+0000');
    const body = b64(String(text).replace(/\r?\n/g, CRLF)).replace(/(.{76})/g, '$1' + CRLF);
    const id = `<${crypto.randomBytes(12).toString('hex')}@${host}>`;
    const name = fromName ? `${encWord(clean(fromName))} <${addrOnly(from)}>` : addrOnly(from);
    return [
        `From: ${name}`, `To: ${addrOnly(to)}`, `Subject: ${encWord(clean(subject))}`,
        `Date: ${date}`, `Message-ID: ${id}`, 'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64',
        'Auto-Submitted: auto-generated', '', body
    ].join(CRLF) + CRLF;
}

// Одно письмо = одно соединение. Возвращает Promise, при любой ошибке отклоняется.
function smtpSend({ host, port, user, pass, from, fromName, mode = 'tls', timeoutMs = 15000, now = Date.now }, { to, subject, text }) {
    return new Promise((resolve, reject) => {
        const opts = { host, port, servername: host };
        const sock = mode === 'plain' ? net.connect(opts) : tls.connect({ ...opts, minVersion: 'TLSv1.2' });
        let buf = '', stage = 0, done = false, pending = null;
        const finish = (err) => {
            if (done) return; done = true;
            clearTimeout(timer);
            try { sock.destroy(); } catch (e) { /* уже закрыт */ }
            err ? reject(err) : resolve();
        };
        const timer = setTimeout(() => finish(new Error('SMTP: таймаут')), timeoutMs);
        const heloHost = clean(os.hostname()).replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
        const message = buildMessage({ from, fromName, to, subject, text, host: heloHost, now });
        const dotted = message.replace(/^\./gm, '..');

        // команда и код, который ждём в ответ
        const steps = [
            [null, 220],
            [`EHLO ${heloHost}`, 250],
            [`AUTH PLAIN ${b64('\u0000' + user + '\u0000' + pass)}`, 235],
            [`MAIL FROM:<${addrOnly(from)}>`, 250],
            [`RCPT TO:<${addrOnly(to)}>`, 250],
            ['DATA', 354],
            [dotted + '.' + CRLF, 250],
            ['QUIT', 221]
        ];
        const next = () => {
            if (stage >= steps.length) return finish();
            const [cmd] = steps[stage];
            if (cmd !== null) sock.write(cmd.endsWith(CRLF) ? cmd : cmd + CRLF);
        };
        const onLine = (line) => {
            const m = /^(\d{3})([ -])/.exec(line);
            if (!m) return;
            pending = pending || { code: m[1], text: '' };
            pending.text += line + '\n';
            if (m[2] === '-') return;                // продолжение многострочного ответа
            const got = Number(pending.code), want = steps[stage][1];
            const info = pending.text.trim().slice(0, 200);
            pending = null;
            if (got !== want) {
                // после отправки письма сервер мог закрыть связь раньше QUIT: это не ошибка
                if (stage === steps.length - 1) return finish();
                return finish(new Error(`SMTP ${got} на шаге ${stage}: ${info}`));
            }
            stage++;
            next();
        };
        sock.setEncoding('utf8');
        sock.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); onLine(line); }
        });
        sock.on('error', (e) => finish(e));
        sock.on('close', () => finish(stage >= steps.length - 1 ? undefined : new Error('SMTP: соединение закрыто')));
    });
}

// mail: { host, port, user, pass, from, fromName } или null
function createMailer(mail, { logger = console, now = Date.now, send = smtpSend } = {}) {
    const enabled = !!(mail && mail.host && mail.user && mail.pass && mail.from);
    return {
        enabled,
        async send({ to, subject, text }) {
            if (!enabled) throw new Error('MAIL_DISABLED');
            const rcpt = clean(to);
            if (!/^[^\s<>@]+@[^\s<>@]+$/.test(rcpt)) throw new Error('BAD_RECIPIENT');
            try { await send({ ...mail, now }, { to: rcpt, subject, text }); }
            catch (e) { logger.error?.(`Письмо не отправлено: ${e && e.message}`); throw e; }
        }
    };
}

module.exports = { createMailer, smtpSend, buildMessage };
