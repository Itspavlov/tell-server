'use strict';
// Создаёт ключи VAPID для push-уведомлений.
//   node scripts/vapid.js          — показать ключи
//   node scripts/vapid.js --env    — вывести строки для файла настроек
const crypto = require('crypto');
const b64u = (b) => Buffer.from(b).toString('base64url');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({ format: 'jwk' });
const prv = privateKey.export({ format: 'jwk' });
const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
const lines = [`VAPID_PUBLIC_KEY=${b64u(raw)}`, `VAPID_PRIVATE_KEY=${prv.d}`];
console.log(lines.join('\n'));
