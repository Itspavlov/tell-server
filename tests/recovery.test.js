'use strict';
// Восстановление доступа: код восстановления, привязка почты, «забыли пароль»; SMTP-клиент
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { AccountStore, nameKey, normRecovery } = require('../src/accounts');
const { createMailer, buildMessage } = require('../src/mailer');
const { validateEmail } = require('../src/validate');
const { createHandlers } = require('../src/http');
const { createAdmin } = require('../src/admin');
const { makeCfg, makeStore, makeIo, limiters, silent } = require('./helpers');

const PW = 'correct horse 9';
const NEW = 'brand new pass 7';
const res = () => { const r = { code: 200, body: null }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.set = () => r; return r; };
const rq = (tok, o = {}) => ({ ip: '6.6.6.6', params: {}, query: {}, headers: tok ? { authorization: 'Bearer ' + tok } : {}, body: {}, ...o });
const nextTick = () => new Promise((r) => setTimeout(r, 20));

async function setup(over = {}) {
    const cfg = makeCfg(over);
    const clock = { t: Date.parse('2027-03-10T12:00:00Z') };
    const now = () => clock.t;
    const accounts = new AccountStore({ dataDir: cfg.dataDir, limits: cfg.limits, logger: silent, now }); await accounts.init();
    const sent = [];
    const mailer = over.noMail ? null : { enabled: true, async send(m) { if (over.failMail) throw new Error('smtp down'); sent.push(m); } };
    const store = await makeStore(cfg);
    const io = makeIo(); const kicked = []; io.in = (room) => ({ disconnectSockets: () => kicked.push(room) });
    const admin = createAdmin({ token: 'c'.repeat(40), dataDir: cfg.dataDir, logger: silent });
    const lim = limiters(cfg, now);
    const h = createHandlers({ cfg, store, admin, accounts, mailer, limiters: lim, io, logger: silent });
    const reg = async (name) => { const r = await accounts.register(name, PW); return { id: r.user.id, token: r.token, code: r.recoveryCode, name }; };
    return { cfg, clock, accounts, sent, kicked, h, reg, lim };
}
const codeOf = (m) => /: (\d{6})/.exec(m.text)[1];

test('SMTP-клиент: разговор с сервером, русская тема, точки в начале строк', async () => {
    const log = []; let data = '';
    const srv = net.createServer((s) => {
        s.setEncoding('utf8'); s.write('220 hi\r\n');
        let inData = false;
        s.on('data', (d) => {
            for (const line of d.split('\r\n')) {
                if (inData) { data += line + '\n'; if (line === '.') { inData = false; s.write('250 queued\r\n'); } continue; }
                if (!line) continue;
                log.push(line.split(' ')[0]);
                if (line.startsWith('EHLO')) s.write('250-x\r\n250 AUTH PLAIN\r\n');
                else if (line.startsWith('AUTH')) { log.push('AUTHDATA:' + Buffer.from(line.split(' ')[2], 'base64').toString().replace(/\0/g, '|')); s.write('235 ok\r\n'); }
                else if (line.startsWith('MAIL') || line.startsWith('RCPT')) s.write('250 ok\r\n');
                else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); }
                else if (line === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
            }
        });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const mailer = createMailer({ host: '127.0.0.1', port: srv.address().port, user: 'me@x.ru', pass: 'pw', from: 'me@x.ru', fromName: 'YuGi YuGi', mode: 'plain' }, { logger: silent });
    await mailer.send({ to: 'a@b.ru', subject: 'Код — тест', text: '.точка в начале\nКод: 123456' });
    srv.close();
    assert.deepEqual(log.filter(x => !x.startsWith('AUTHDATA')), ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
    assert.ok(log.includes('AUTHDATA:|me@x.ru|pw'));
    assert.match(data, /Subject: =\?UTF-8\?B\?/);
    const body = Buffer.from(data.split('\n\n')[1].replace(/\n/g, ''), 'base64').toString();
    assert.match(body, /Код: 123456/);
});

test('SMTP-клиент: отказ сервера и выключенная почта дают ошибку', async () => {
    const srv = net.createServer((s) => { s.write('220 hi\r\n'); s.on('data', () => s.write('535 bad auth\r\n')); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const mailer = createMailer({ host: '127.0.0.1', port: srv.address().port, user: 'u', pass: 'p', from: 'u@x.ru', mode: 'plain' }, { logger: silent });
    await assert.rejects(() => mailer.send({ to: 'a@b.ru', subject: 's', text: 't' }), /SMTP 250|SMTP 535/);
    srv.close();
    const off = createMailer(null, { logger: silent });
    assert.equal(off.enabled, false);
    await assert.rejects(() => off.send({ to: 'a@b.ru', subject: 's', text: 't' }), /MAIL_DISABLED/);
    assert.match(buildMessage({ from: 'a@b.ru', to: 'c@d.ru', subject: 'x\r\nBcc: z@z.ru', text: 't', host: 'h', now: Date.now }), /Subject: x Bcc: z@z\.ru\r\n/);
});

test('проверка адреса почты', () => {
    assert.equal(validateEmail('Taras@Mail.RU').value, 'taras@mail.ru');
    assert.equal(validateEmail('a@почта.рф').value, 'a@xn--80a1acny.xn--p1ai');
    for (const bad of ['', 'a', 'a@b', 'a b@c.ru', 'a@@c.ru', 'тарас@c.ru', 'a..b@c.ru', null, 5]) assert.equal(validateEmail(bad).ok, false, String(bad));
});

test('регистрация выдаёт код восстановления; хранится только хеш', async () => {
    const { accounts, reg } = await setup();
    const u = await reg('Тарас');
    assert.match(u.code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    const stored = JSON.stringify(accounts.data.users[u.id]);
    assert.ok(!stored.includes(u.code) && !stored.includes(u.code.replace(/-/g, '')));
    assert.equal(normRecovery(u.code.toLowerCase().replace(/-/g, ' ')), u.code.replace(/-/g, ''));
});

test('сброс по коду восстановления: новый пароль, выход везде, одноразовость и новый код', async () => {
    const { h, accounts, reg, kicked } = await setup();
    const u = await reg('Тарас');
    const old2 = await accounts.login('Тарас', PW);                       // вторая сессия
    const r1 = res();
    await h.resetConfirm(rq(null, { body: { name: 'тарас', method: 'recovery', code: u.code.toLowerCase(), password: NEW } }), r1);
    assert.equal(r1.code, 200); assert.ok(r1.body.token && r1.body.recoveryCode);
    assert.notEqual(r1.body.recoveryCode, u.code);
    assert.equal(accounts.authenticate(u.token), null);
    assert.equal(accounts.authenticate(old2.token), null);
    assert.ok(accounts.authenticate(r1.body.token));
    assert.equal((await accounts.login('Тарас', NEW)).ok, true);
    assert.equal((await accounts.login('Тарас', PW)).ok, false);
    assert.deepEqual(kicked, ['user:' + u.id]);
    const r2 = res();                                                      // старый код больше не годится
    await h.resetConfirm(rq(null, { body: { name: 'Тарас', method: 'recovery', code: u.code, password: 'another pass 1' } }), r2);
    assert.equal(r2.code, 400); assert.equal(r2.body.code, 'RESET_FAILED');
    const r3 = res();                                                      // а новый — годится
    await h.resetConfirm(rq(null, { body: { name: 'Тарас', method: 'recovery', code: r1.body.recoveryCode, password: 'another pass 1' } }), r3);
    assert.equal(r3.code, 200);
});

test('сброс: чужой код, несуществующее имя, слабый пароль; блокировка после 5 неудач', async () => {
    const { h, reg, lim } = await setup();
    const a = await reg('Алиса'); const b = await reg('Борис');
    const go = async (body) => { const r = res(); await h.resetConfirm(rq(null, { body }), r); return r; };
    assert.equal((await go({ name: 'Алиса', method: 'recovery', code: b.code, password: NEW })).body.code, 'RESET_FAILED');
    assert.equal((await go({ name: 'Нетакого', method: 'recovery', code: a.code, password: NEW })).body.code, 'RESET_FAILED');
    assert.equal((await go({ name: 'Алиса', method: 'recovery', code: a.code, password: 'short' })).body.code, 'BAD_PASSWORD');
    assert.equal((await go({ name: 'Алиса', method: 'sms', code: a.code, password: NEW })).code, 400);
    for (let i = 0; i < 4; i++) await go({ name: 'Алиса', method: 'recovery', code: 'AAAA-AAAA-AAAA-AAAA', password: NEW });
    const locked = await go({ name: 'Алиса', method: 'recovery', code: a.code, password: NEW });   // 5-я неудача уже была: верный код тоже не пускает
    assert.equal(locked.code, 429); assert.equal(locked.body.code, 'RESET_LOCKED');
    // у несуществующего имени то же поведение (нельзя узнать, есть ли аккаунт)
    for (let i = 0; i < 5; i++) await go({ name: 'Призрак', method: 'recovery', code: 'AAAA-AAAA-AAAA-AAAA', password: NEW });
    assert.equal((await go({ name: 'Призрак', method: 'recovery', code: 'AAAA-AAAA-AAAA-AAAA', password: NEW })).body.code, 'RESET_LOCKED');
});

test('новый код восстановления по паролю заменяет прежний', async () => {
    const { h, reg } = await setup();
    const u = await reg('Тарас');
    const bad = res(); await h.recoveryCodeNew(rq(u.token, { body: { password: 'wrong' } }), bad);
    assert.equal(bad.code, 401);
    const ok = res(); await h.recoveryCodeNew(rq(u.token, { body: { password: PW } }), ok);
    assert.equal(ok.code, 200); assert.notEqual(ok.body.code, u.code);
    const st = res(); h.recoveryInfo(rq(u.token), st);
    assert.equal(st.body.hasCode, true); assert.equal(st.body.email, '');
    const old = res(); await h.resetConfirm(rq(null, { body: { name: 'Тарас', method: 'recovery', code: u.code, password: NEW } }), old);
    assert.equal(old.code, 400);
    const none = res(); await h.recoveryCodeNew(rq(null), none); assert.equal(none.code, 401);
});

test('привязка почты: письмо, неверный код, подтверждение, смена, удаление', async () => {
    const { h, accounts, reg, sent, clock } = await setup();
    const u = await reg('Тарас'); const v = await reg('Вера');
    const wrongPw = res(); await h.emailStart(rq(u.token, { body: { password: 'nope', email: 'taras@mail.ru' } }), wrongPw);
    assert.equal(wrongPw.code, 401); assert.equal(sent.length, 0);
    const badMail = res(); await h.emailStart(rq(u.token, { body: { password: PW, email: 'oops' } }), badMail);
    assert.equal(badMail.body.code, 'BAD_EMAIL');
    const s1 = res(); await h.emailStart(rq(u.token, { body: { password: PW, email: 'Taras@Mail.ru' } }), s1);
    assert.equal(s1.code, 200); assert.equal(sent.length, 1); assert.equal(sent[0].to, 'taras@mail.ru');
    const again = res(); await h.emailStart(rq(u.token, { body: { password: PW, email: 'taras@mail.ru' } }), again);
    assert.equal(again.code, 429); assert.equal(again.body.code, 'MAIL_WAIT');
    const code = codeOf(sent[0]);
    const wrong = res(); await h.emailConfirm(rq(u.token, { body: { code: code === '000000' ? '111111' : '000000' } }), wrong);
    assert.equal(wrong.body.code, 'BAD_CODE');
    const okc = res(); await h.emailConfirm(rq(u.token, { body: { code } }), okc);
    assert.equal(okc.code, 200); assert.equal(okc.body.email, 'ta***@mail.ru');
    assert.equal(accounts.emailOf(u.id), 'taras@mail.ru');
    const st = res(); h.recoveryInfo(rq(u.token), st); assert.equal(st.body.email, 'ta***@mail.ru');
    clock.t += 61000;                                                      // чужая почта: нельзя привязать вторую раз
    const taken = res(); await h.emailStart(rq(v.token, { body: { password: PW, email: 'taras@mail.ru' } }), taken);
    assert.equal(taken.code, 409); assert.equal(taken.body.code, 'EMAIL_TAKEN');
    const rm = res(); await h.emailRemove(rq(u.token, { body: { password: PW } }), rm);
    assert.equal(rm.code, 200); assert.equal(accounts.emailOf(u.id), '');
    const nowFree = res(); await h.emailStart(rq(v.token, { body: { password: PW, email: 'taras@mail.ru' } }), nowFree);
    assert.equal(nowFree.code, 200);
});

test('код из письма: срок 15 минут и не больше 5 попыток', async () => {
    const { h, reg, sent, clock } = await setup();
    const u = await reg('Тарас');
    await h.emailStart(rq(u.token, { body: { password: PW, email: 'a@b.ru' } }), res());
    const code = codeOf(sent[0]);
    clock.t += 16 * 60 * 1000;
    const exp = res(); await h.emailConfirm(rq(u.token, { body: { code } }), exp);
    assert.equal(exp.body.code, 'CODE_EXPIRED');
    clock.t += 61000;
    await h.emailStart(rq(u.token, { body: { password: PW, email: 'a@b.ru' } }), res());
    const real = codeOf(sent[1]); const bad = real === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) await h.emailConfirm(rq(u.token, { body: { code: bad } }), res());
    const after = res(); await h.emailConfirm(rq(u.token, { body: { code: real } }), after);
    assert.equal(after.code >= 400, true);                                 // код сгорел после 5 неверных попыток
});

test('«забыли пароль» по почте: одинаковый ответ, письмо только владельцу, смена пароля и вход', async () => {
    const { h, accounts, reg, sent, clock } = await setup();
    const u = await reg('Тарас'); await reg('Без почты');
    await h.emailStart(rq(u.token, { body: { password: PW, email: 'taras@mail.ru' } }), res());
    await h.emailConfirm(rq(u.token, { body: { code: codeOf(sent[0]) } }), res());
    sent.length = 0;
    const r0 = res(); await h.resetStart(rq(null, { body: { name: 'Без почты' } }), r0);
    const r00 = res(); await h.resetStart(rq(null, { body: { name: 'Нетакого' } }), r00);
    const r1 = res(); await h.resetStart(rq(null, { body: { name: 'тарас' } }), r1);
    await nextTick();
    for (const r of [r0, r00, r1]) { assert.equal(r.code, 200); assert.deepEqual(r.body, { ok: true }); }
    assert.equal(sent.length, 1); assert.equal(sent[0].to, 'taras@mail.ru');
    const code = codeOf(sent[0]);
    const again = res(); await h.resetStart(rq(null, { body: { name: 'Тарас' } }), again); await nextTick();
    assert.equal(sent.length, 1);                                          // не чаще раза в минуту
    const wrong = res(); await h.resetConfirm(rq(null, { body: { name: 'Тарас', method: 'email', code: code === '000000' ? '111111' : '000000', password: NEW } }), wrong);
    assert.equal(wrong.body.code, 'RESET_FAILED');
    const ok = res(); await h.resetConfirm(rq(null, { body: { name: 'Тарас', method: 'email', code, password: NEW } }), ok);
    assert.equal(ok.code, 200); assert.equal(ok.body.recoveryCode, undefined);
    assert.equal(accounts.authenticate(u.token), null);
    assert.equal((await accounts.login('Тарас', NEW)).ok, true);
    await nextTick();
    assert.ok(sent.some(m => /Пароль изменён/.test(m.subject)));
    const reuse = res(); await h.resetConfirm(rq(null, { body: { name: 'Тарас', method: 'email', code, password: 'once more 12' } }), reuse);
    assert.equal(reuse.code, 400);
    clock.t += 1;
});

test('почта выключена: сброс и привязка по почте сообщают об этом, остальное работает', async () => {
    const { h, reg } = await setup({ noMail: true });
    const u = await reg('Тарас');
    const o = res(); h.authOptions(rq(null), o); assert.equal(o.body.mail, false);
    const a = res(); await h.resetStart(rq(null, { body: { name: 'Тарас' } }), a); assert.equal(a.code, 503); assert.equal(a.body.code, 'MAIL_DISABLED');
    const b = res(); await h.emailStart(rq(u.token, { body: { password: PW, email: 'a@b.ru' } }), b); assert.equal(b.code, 503);
    const c = res(); await h.resetConfirm(rq(null, { body: { name: 'Тарас', method: 'recovery', code: u.code, password: NEW } }), c); assert.equal(c.code, 200);
});

test('сбой отправки письма: привязку можно повторить сразу; суточный лимит писем', async () => {
    const { h, reg, lim } = await setup({ failMail: true });
    const u = await reg('Тарас');
    const f = res(); await h.emailStart(rq(u.token, { body: { password: PW, email: 'a@b.ru' } }), f);
    assert.equal(f.code, 502); assert.equal(f.body.code, 'MAIL_FAILED');
    const f2 = res(); await h.emailStart(rq(u.token, { body: { password: PW, email: 'a@b.ru' } }), f2);
    assert.equal(f2.code, 502);                                            // не MAIL_WAIT
    const g = await setup(); const w = await g.reg('Вера');
    for (let i = 0; i < g.cfg.rates.mailGlobal.max; i++) g.lim.mailGlobal.hit('all');
    const r = res(); await g.h.emailStart(rq(w.token, { body: { password: PW, email: 'v@b.ru' } }), r);
    assert.equal(r.code, 503); assert.equal(r.body.code, 'MAIL_LIMIT');
});

test('удаление аккаунта освобождает почту; сохранение при сбое не ломает пароль', async () => {
    const { h, accounts, reg, sent, clock } = await setup();
    const u = await reg('Тарас');
    await h.emailStart(rq(u.token, { body: { password: PW, email: 'taras@mail.ru' } }), res());
    await h.emailConfirm(rq(u.token, { body: { code: codeOf(sent[0]) } }), res());
    assert.ok((await accounts.removeUser(u.id)).ok);
    assert.equal(accounts.byEmail.size, 0);
    const v = await reg('Вера');
    clock.t += 61000;
    const r = res(); await h.emailStart(rq(v.token, { body: { password: PW, email: 'taras@mail.ru' } }), r);
    assert.equal(r.code, 200);
});
