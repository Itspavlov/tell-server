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

// l — объявление в том виде, как оно хранится в ListingStore
function matches(req, l) {
    const a = l && l.ad;
    if (!a || a.type !== 'rent') return false;
    if (req.category && (a.category || 'apartment') !== req.category) return false;
    if (req.city) {
        const hay = norm(a.location + ' ' + a.title);
        if (!hay.includes(norm(req.city))) return false;
    }
    if (req.district) {
        const hay = norm(a.location + ' ' + a.title + ' ' + a.description);
        if (!hay.includes(norm(req.district))) return false;
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

module.exports = { matches, nights, guestCapacity };
