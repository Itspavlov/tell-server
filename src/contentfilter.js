'use strict';
// ============================================
// Фильтр мусорных публикаций. Работает на входе: карточка с очевидным мусором не попадает в ленту.
// Только явные случаи (мат, ссылки, заработок/крипта/казино, продажа машины в «Жилье», нереальная цена);
// сомнительное остаётся жалобам: автоскрытие и очередь модератора уже есть.
// ============================================

const LAT = { a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у', k: 'к', m: 'м', h: 'н', t: 'т', b: 'в' };
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[a-z]/g, (c) => LAT[c] || c)
    .replace(/[​-‏­]/g, '');
// слова без «обфускации» через точки и звёздочки: х*й, п.и.з.д.а
const squash = (s) => norm(s).replace(/(?<=[а-я])[*._\-\s]+(?=[а-я])/g, (m) => (m.length <= 2 && /[*._\-]/.test(m) ? '' : m));

const RE_URL = /(https?:\/\/|www\.|\bt\.me\/|\bwa\.me\/|[a-z0-9-]+\.(ru|com|net|org|рф|su|info|xyz|club|top|site|online)\b)/i;
const RE_MAT = /(^|[^а-я])(ху[йяеи]|пизд|бляд|бля($|[^а-я])|еб[аоуыи]н|ебат|ебл[аяи]|заеб|выеб|долбо[её]б|муда[кч]|мудил|гондон|пидор|пидар)/;
const RE_SPAM = /(быстр[а-я]* деньг|легк[а-я]* (заработ|деньг)|заработок (на|в|от) |пассивн[а-я]* доход|крипт|биткоин|bitcoin|инвестиц|форекс|ставки на спорт|казино|букмекер|микрозайм|займ[ыа]? (онлайн|без)|кредит без|интим|эскорт|18\+|порн|ставк[а-я]* на|продвижение в соцсет|накрутка|обнал)/;
// в разделе «Жильё» не продают технику, одежду, машины
const OFFTOPIC_NOUN = /(^|[^а-я])(авто|бмв|bmw|мерседес|mercedes|тойота|toyota|камри|лада|ваз|киа|kia|хендай|hyundai|ниссан|nissan|фольксваген|volkswagen|ауди|audi|форд|ford|мазда|mazda|пробег[а-я]*|птс|двигател[а-я]*|автомобил[а-я]*|машин[аыуе]|иномарк[а-я]*|iphone|айфон[а-я]*|телефон[а-я]*|смартфон[а-я]*|ноутбук[а-я]*|планшет[а-я]*|велосипед[а-я]*|мотоцикл[а-я]*|скутер[а-я]*|мопед[а-я]*|шуб[аыу]|куртк[а-я]*|платье|кроссовк[а-я]*|щен(ок|ки|ков)|котят[а-я]*|коляск[а-я]*|диван|холодильник|стиральн[а-я]* машин[а-я]*)([^а-я]|$)/;
const RE_LAT_GOODS = /\b(bmw|mercedes|toyota|kia|hyundai|nissan|volkswagen|audi|ford|mazda|lexus|tesla|iphone|samsung|macbook|playstation)\b/i;
const RE_TRADE = /(продам|продаю|продается|продаётся|куплю|меняю|обмен|отдам|б\/у|срочно продаю)/;

function reject(code, message) { return { ok: false, code: 'CONTENT_REJECTED', reason: code, message }; }

// section: housing | work | trips | services | any; f: { title, text, priceNum, long }
function checkContent(section, f) {
    const title = squash(f.title), text = squash(f.text);
    const all = title + ' \n ' + text;
    if (RE_MAT.test(all) || /х[*@#%]й|п[*@#%]зд|б[*@#%]я[дт]/.test(norm(f.title) + ' ' + norm(f.text))) return reject('profanity', 'В тексте есть недопустимые слова. Уберите их и опубликуйте снова');
    if (RE_SPAM.test(all)) return reject('spam', 'Такие объявления у нас не размещают. Здесь только жильё, работа, поездки и развлечения курорта');
    const rawTitle = String(f.title || '').toLowerCase(), rawAll = rawTitle + ' \n ' + String(f.text || '').toLowerCase();
    if (RE_URL.test(rawTitle)) return reject('link', 'В названии не должно быть ссылок. Контакты можно писать в личных сообщениях');
    if (/(https?:\/\/|www\.|\bt\.me\/|\bwa\.me\/)/.test(rawAll)) return reject('link', 'Ссылки в карточках не разрешены. Покупатели напишут вам в личные сообщения');
    if (section === 'housing') {
        // название про не жильё, либо «продам/куплю» вместе с не-жилищным предметом
        if (OFFTOPIC_NOUN.test(title) || RE_LAT_GOODS.test(rawTitle) || (RE_TRADE.test(all) && OFFTOPIC_NOUN.test(all))) {
            return reject('offtopic', 'В разделе «Жильё» размещают только жильё. Машины и вещи сюда не подходят');
        }
        if (RE_TRADE.test(title) && /(продам|продаю|продается|продаётся)/.test(title)) return reject('sale', 'Продажа в «Жилье» недоступна: здесь только аренда');
        const p = Number(f.priceNum);
        if (Number.isFinite(p)) {
            const lo = f.long ? 3000 : 300, hi = f.long ? 1500000 : 150000;
            if (p < lo || p > hi) return reject('price', f.long ? 'Укажите реальную цену за месяц: от 3 000 ₽' : 'Укажите реальную цену за сутки: от 300 ₽');
        }
    }
    return { ok: true };
}

module.exports = { checkContent, squash };
