'use strict';
// ============================================
// Подбор жилья под запрос арендатора (первая версия: надёжная фильтрация по параметрам).
// Обязательные условия: тип «аренда», категория, город, бюджет, свободные даты, число гостей.
// Если у объявления нет нужных данных (например, не указано число гостей),
// оно не отбрасывается по этому условию, но занятые даты и цена проверяются всегда.
// В будущем здесь можно подключить рекомендации на основе ИИ.
// ============================================

const DAY = 86400000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// Ночи проживания: от заезда до дня перед выездом; если выезд не указан — одна ночь
function nights(from, to) {
    if (!from) return [];
    const a = Date.parse(from + 'T00:00:00Z');
    const b = to ? Date.parse(to + 'T00:00:00Z') : a + DAY;
    const out = [];
    for (let t = a; t < Math.max(b, a + DAY) && out.length < 400; t += DAY) out.push(isoDay(t));
    return out;
}

function guestCapacity(l) {
    const g = Number(l.ad && l.ad.form && l.ad.form.guests);
    if (Number.isFinite(g) && g > 0) return g;
    for (const f of (l.ad && l.ad.facts) || []) {
        const m = /до\s+(\d+)\s+гост/i.exec(f && f.t || '');
        if (m) return Number(m[1]);
    }
    return null;
}

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();

// Нестрогое сравнение названий: без пробелов, дефисов и знаков, с учётом падежных окончаний.
// «Архипо-Осиповка», «Архипо Осиповка» и «в Архипо-Осиповке» считаются одним местом.
const squash = (s) => norm(s).replace(/[^a-zа-я0-9]/g, '');
function mentions(hay, needle) {
    const n = squash(needle);
    if (!n) return true;
    const stem = n.length >= 6 ? n.slice(0, n.length - 2) : n.length === 5 ? n.slice(0, 4) : n;
    return squash(hay).includes(stem);
}

// Разрешены ли животные: хозяин отметил удобство «С животными»
function allowsPets(l) {
    return ((l.ad && l.ad.amenities) || []).some(x => /животн/i.test(String(x)));
}

// l — объявление в том виде, как оно хранится в ListingStore
// opts.anyType: не сверять категорию (для блока «Другие типы жилья»)
function matches(req, l, opts) {
    // карточки «Ищу/Предоставляю» других разделов к жилью не подбираются
    if (req && req.section && req.section !== 'housing') return false;
    const a = l && l.ad;
    if (!a || a.type !== 'rent') return false;
    if (!(opts && opts.anyType) && req.category && (a.category || 'apartment') !== req.category) return false;
    if (req.pets && !allowsPets(l)) return false;
    if (req.city) {
        if (!mentions(a.location + ' ' + a.title, req.city)) return false;
    }
    if (req.district) {
        if (!mentions(a.location + ' ' + a.title + ' ' + a.description, req.district)) return false;
    }
    if (req.budget && a.priceNum > req.budget) return false;
    if (req.guests) {
        const cap = guestCapacity(l);
        if (cap !== null && cap < req.guests) return false;
    }
    if (req.dateFrom && a.busy && a.busy.length) {
        const busy = new Set(a.busy);
        if (nights(req.dateFrom, req.dateTo).some(d => busy.has(d))) return false;
    }
    return true;
}

// Подходит по всем условиям, кроме типа жилья: цена, гости, даты, место и животные те же
function similar(req, l) {
    return !!(req && req.category) && matches(req, l, { anyType: true }) && !matches(req, l);
}

module.exports = { matches, similar, allowsPets, nights, guestCapacity, mentions };
