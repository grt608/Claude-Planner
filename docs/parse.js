// Free, offline natural-language task parser.
//
// parseLocal(text, now, opts) -> one task; parseAll(text, now, opts) -> one or more tasks.
// A task is { title, description, due: Date, durationMin: number|null, repeat: object|null, cat: string,
//             dateUnderstood, dateGiven, timeUnderstood, foundWhen, notes: [{level:'warn'|'info', text}] }.
// repeat is { freq: 'DAILY'|'WEEKLY'|'MONTHLY'|'YEARLY', interval: n, byday?: ['MO', ...] }.
// All arithmetic is done in the device's local time, so results do not depend on the time zone.
// opts: { defaultTime: 'HH:MM' } (default 09:00).

const WD = '(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)';
const WDP = '(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)';
const WDITEM = `(?:${WDP}|${WD})`;
const WDSEP = '(?:\\s*[,&/]\\s*(?:and\\s+)?|\\s+and\\s+|\\s+)';
const WDLIST = `${WDITEM}(?:${WDSEP}${WDITEM})*`;
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const PARTWORD = '(?:morning|afternoon|evening|night)';
const NUM = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)';
const COMP = '(?:half\\s+an?|an?|\\d+(?:\\.\\d+)?)\\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?)';
const WD_ABBR = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MON_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NUMWORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
export const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
export const MAX_DURATION_MIN = 60 * 24 * 31;
const FREQ = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' };

const wdIdx = (s) => WD_ABBR.indexOf(s.slice(0, 3).toLowerCase());
const monIdx = (s) => MON_ABBR.indexOf(s.slice(0, 3).toLowerCase());
const num = (s) => (/^\d+$/.test(s) ? +s : NUMWORDS[s.toLowerCase()]);
const clampInterval = (n) => Math.min(99, Math.max(1, Math.floor(n) || 1));
const weekdays = (text) => {
  const idx = [...text.matchAll(new RegExp(`${WDP}|${WD}`, 'gi'))].map((x) => wdIdx(x[0]));
  return [...new Set(idx)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((i) => BYDAY[i]); // Monday first
};

// Named times of day. "morning" etc. only count after a day word ("tomorrow morning", "friday evening").
const PARTS = {
  morning: [9, 0],
  noon: [12, 0],
  midday: [12, 0],
  afternoon: [15, 0],
  evening: [18, 0],
  tonight: [20, 0],
  night: [20, 0],
  midnight: [0, 0],
  eod: [17, 0],
  cob: [17, 0],
};
const PM_PARTS = ['afternoon', 'evening', 'night', 'tonight'];

export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function addMonths(d, n) {
  // Same day-of-month, clamped to the end of the target month.
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1, d.getHours(), d.getMinutes());
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), last));
  return target;
}

function at(day, h, m) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
}

/** A date the app can store and export: a real instant between 1990 and 2200. */
export function isPlausible(d) {
  return d instanceof Date && Number.isFinite(d.getTime()) && d.getFullYear() >= 1990 && d.getFullYear() <= 2200;
}

// A calendar date, or null when it does not exist (Feb 30 would otherwise roll over into March).
function mkDate(y, mo, d) {
  const dt = new Date(y, mo, d);
  return y >= 1990 && y <= 2200 && dt.getFullYear() === y && dt.getMonth() === mo && dt.getDate() === d ? dt : null;
}

function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  return m && +m[1] < 24 && +m[2] < 60 ? { h: +m[1], m: +m[2] } : null;
}

const to24 = (h, ampm) => (h % 12) + (/^p/i.test(ampm) ? 12 : 0);
const fmtTime = (h, m) => `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;

/** Keep the title readable: cut at a word boundary and move the overflow into the description. */
export function fitTitle(title, description = '') {
  let t = String(title || '').trim();
  let d = String(description || '').trim();
  if (t.length > 80) {
    let cut = t.lastIndexOf(' ', 80);
    if (cut < 40) cut = 80;
    d = [t.slice(cut).trim(), d].filter(Boolean).join('. ');
    t = t.slice(0, cut).replace(/[\s,.\-—–:;]+$/, '');
  }
  return { title: t, description: d };
}

// Parses one chunk of text. Returns the raw result (title may be empty).
function parseChunk(text, now, opts) {
  const def = parseHM(opts.defaultTime) || { h: 9, m: 0 };
  const original = String(text);
  let rest = ' ' + original.replace(/\s+/g, ' ').trim() + ' ';
  const notes = [];
  const take = (re) => {
    const m = re.exec(rest);
    if (m) rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length);
    return m;
  };

  let found = false;
  let cat = '';
  let repeat = null;
  let durationMin = null;
  let abs = null; // exact moment: "in 2 hours", "in 30 minutes"
  let base = null; // start of the target day, or {dom} for "the 15th"
  let wdTarget = -1; // weekday named by the user, if any
  let weekdayBased = false;
  let yearless = false;
  let implicitToday = false;
  let time = null; // [h, m]
  let clockGiven = false;
  let part = null;
  let guessed = null;
  let badDate = false;
  let m;

  // #tag
  if ((m = take(/(?:^|\s)#([\p{L}\d_-]+)/iu))) cat = m[1].toLowerCase();

  // ISO date
  if ((m = take(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/))) {
    base = mkDate(+m[1], +m[2] - 1, +m[3]);
    if (!base) badDate = true;
    found = true;
  }

  // ---- repeat ----
  const part2 = (mm, i) => {
    if (mm[i]) part = mm[i].toLowerCase();
  };
  if ((m = take(new RegExp(`\\b(?:every|each)\\s+${NUM}\\s+(day|week|month|year)s?(?:\\s+on\\s+(${WDLIST}))?\\b`, 'i')))) {
    repeat = { freq: FREQ[m[2].toLowerCase()], interval: clampInterval(num(m[1])) };
    if (num(m[1]) > 99) notes.push({ level: 'warn', text: 'Repeats can be at most every 99, so 99 was used.' });
    if (repeat.freq === 'WEEKLY' && m[3]) repeat.byday = weekdays(m[3]);
  } else if ((m = take(new RegExp(`\\b(?:every|each)\\s+other\\s+(day|week|month|year)(?:\\s+on\\s+(${WDLIST}))?\\b`, 'i')))) {
    repeat = { freq: FREQ[m[1].toLowerCase()], interval: 2 };
    if (repeat.freq === 'WEEKLY' && m[2]) repeat.byday = weekdays(m[2]);
  } else if (take(/\b(?:bi-?weekly|fortnightly)\b/i)) {
    repeat = { freq: 'WEEKLY', interval: 2 };
  } else if ((m = take(new RegExp(`\\b(?:every\\s+weekday|on\\s+weekdays|weekdays|(?:mon|monday)\\s*(?:-|to|through|thru)\\s*(?:fri|friday))(?:\\s+(${PARTWORD}))?\\b`, 'i')))) {
    repeat = { freq: 'WEEKLY', interval: 1, byday: ['MO', 'TU', 'WE', 'TH', 'FR'] };
    part2(m, 1);
  } else if ((m = take(new RegExp(`\\b(?:every|each)\\s+other\\s+(${WD})\\b`, 'i')))) {
    repeat = { freq: 'WEEKLY', interval: 2, byday: [BYDAY[wdIdx(m[1])]] };
  } else if ((m = take(new RegExp(`\\b(?:every|each)\\s+(${WDLIST})(?:\\s+(${PARTWORD}))?\\b`, 'i')))) {
    repeat = { freq: 'WEEKLY', interval: 1, byday: weekdays(m[1]) };
    part2(m, 2);
  } else if ((m = take(new RegExp(`\\b(?:on\\s+)?(${WDP}(?:${WDSEP}${WDITEM})*)(?:\\s+(${PARTWORD}))?\\b`, 'i')))) {
    repeat = { freq: 'WEEKLY', interval: 1, byday: weekdays(m[1]) };
    part2(m, 2);
  } else if (take(/\b(?:every|each)\s+weekend\b/i)) {
    repeat = { freq: 'WEEKLY', interval: 1, byday: ['SA', 'SU'] };
  } else if ((m = take(/\b(?:every|each)\s*(day|week|month|year)\b/i))) {
    repeat = { freq: FREQ[m[1].toLowerCase()], interval: 1 };
  } else if ((m = take(new RegExp(`\\b(?:every|each)\\s+(${PARTWORD})\\b`, 'i')))) {
    repeat = { freq: 'DAILY', interval: 1 };
    part = m[1].toLowerCase();
  } else if ((m = /\b(daily|weekly|monthly|yearly|annually|nightly)\b/i.exec(rest)) && m.index > 1 && take(/\b(daily|weekly|monthly|yearly|annually|nightly)\b/i)) {
    // Only after the first word: "Pay rent monthly" repeats, "Yearly check up" is just a title.
    const w = m[1].toLowerCase();
    repeat = { freq: { daily: 'DAILY', nightly: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY', annually: 'YEARLY' }[w], interval: 1 };
    if (w === 'nightly') part = 'night';
  }
  if (repeat) found = true;
  else if (/\b(?:every|each)\b/i.test(rest)) notes.push({ level: 'warn', text: 'Could not understand the repeat, so this is a one-off task.' });

  // ---- duration ----
  if ((m = take(/\bfor\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i))) {
    durationMin = Math.round(+m[1] * (/^h/i.test(m[2]) ? 60 : 1));
  } else if (take(/\bfor\s+(?:an?|one)\s+(?:hour|hr)\b/i)) {
    durationMin = 60;
  } else if (take(/\bfor\s+half\s+an?\s+hour\b/i)) {
    durationMin = 30;
  }

  // ---- time range: "2-3pm", "from 9 to 5pm", "9am - 10:30am" ----
  if ((m = take(/(?:\bfrom\s+|\bat\s+|\b)(\d{1,2})(?:[:.](\d{2}))?\s*([ap](?:m|\.m\.?))?\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?:[:.](\d{2}))?\s*([ap](?:m|\.m\.?))(?![a-z])/i))) {
    const endMer = m[6];
    const sh0 = +m[1];
    const eh0 = +m[4];
    if (sh0 >= 1 && sh0 <= 12 && eh0 >= 1 && eh0 <= 12 && (!m[2] || +m[2] < 60) && (!m[5] || +m[5] < 60)) {
      let sh = to24(sh0, m[3] || endMer);
      const sm = m[2] ? +m[2] : 0;
      const eh = to24(eh0, endMer);
      const em = m[5] ? +m[5] : 0;
      if (!m[3] && sh * 60 + sm > eh * 60 + em) sh = to24(sh0, /^p/i.test(endMer) ? 'am' : 'pm'); // "11-1pm" is 11am-1pm
      time = [sh, sm];
      clockGiven = true;
      durationMin = Math.max(5, eh * 60 + em - (sh * 60 + sm));
      found = true;
    } else {
      rest += ' ' + m[0];
    }
  }

  // ---- relative: "in 2 hours", "in 3 days", "in 2 hours 30 minutes", "in an hour and a half" ----
  if ((m = take(new RegExp(`\\bin\\s+(${COMP}(?:\\s*(?:,|and)?\\s*${COMP})*)(\\s*(?:,|and)?\\s*a\\s+half)?\\b`, 'i')))) {
    let minutes = 0;
    let days = 0;
    let months = 0;
    let last = null;
    for (const c of m[1].matchAll(new RegExp(`(half\\s+an?|an?|\\d+(?:\\.\\d+)?)\\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?)`, 'gi'))) {
      const n = /^half/i.test(c[1]) ? 0.5 : /^an?$/i.test(c[1]) ? 1 : +c[1];
      const u = c[2].toLowerCase();
      last = u.startsWith('mi') ? 'min' : u.startsWith('h') ? 'hour' : u.startsWith('d') ? 'day' : u.startsWith('w') ? 'week' : 'month';
      if (last === 'min') minutes += n;
      else if (last === 'hour') minutes += n * 60;
      else if (last === 'day') days += n;
      else if (last === 'week') days += n * 7;
      else months += n;
    }
    if (m[2] && last) {
      const half = { min: 0.5, hour: 30, day: 0.5, week: 3.5, month: 0.5 }[last];
      if (last === 'min' || last === 'hour') minutes += half;
      else if (last === 'month') months += half;
      else days += half;
    }
    found = true;
    if (![minutes, days, months].every(Number.isFinite) || minutes > 1e8 || days > 1e5 || months > 1e4) {
      badDate = true;
    } else if (minutes > 0) {
      abs = addMonths(now, Math.round(months));
      abs.setDate(abs.getDate() + Math.round(days));
      abs = new Date(abs.getTime() + Math.round(minutes) * 60000);
      abs.setSeconds(0, 0);
    } else if (months > 0 && days === 0) {
      base = addMonths(startOfDay(now), Math.round(months));
    } else {
      base = addMonths(startOfDay(now), Math.round(months));
      base = addDays(base, Math.round(days));
    }
  }

  // ---- month-name dates ----
  if (!base) {
    if ((m = take(new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i')))) {
      base = mkDate(m[3] ? +m[3] : now.getFullYear(), monIdx(m[1]), +m[2]);
      if (!base) badDate = true;
      yearless = !m[3];
      found = true;
    } else if ((m = take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})\\b\\.?(?:,?\\s+(\\d{4}))?`, 'i')))) {
      base = mkDate(m[3] ? +m[3] : now.getFullYear(), monIdx(m[2]), +m[1]);
      if (!base) badDate = true;
      yearless = !m[3];
      found = true;
    }
  }

  // ---- "tomorrow morning", "friday evening", "this afternoon", "in the evening" ----
  const partRe = new RegExp(`\\b(this|tomorrow|tomorow|tmrw|tmr|tmw|today|in\\s+the|${WD})\\s+(${PARTWORD})\\b`, 'i');
  if ((m = partRe.exec(rest))) {
    const prefix = m[1].toLowerCase().replace(/\s+/g, ' ');
    part = m[2].toLowerCase();
    found = true;
    const keep = prefix === 'this' || prefix === 'in the' ? ' ' : ` ${m[1]} `;
    rest = rest.slice(0, m.index) + keep + rest.slice(m.index + m[0].length);
    if (prefix === 'this' && !base) base = startOfDay(now);
  }

  // ---- day words ----
  if (!base) {
    if (take(/\b(?:the\s+)?day\s+after\s+(?:tomorrow|tmrw|tmr)\b/i)) {
      base = addDays(startOfDay(now), 2);
      found = true;
    } else if (take(/\b(?:tomorrow|tomorow|tommorow|tommorrow|tmrw|tmr|tmw|2moro|2morrow)\b/i)) {
      base = addDays(startOfDay(now), 1);
      found = true;
    } else if ((m = take(/\b(today|tonight)\b/i))) {
      base = startOfDay(now);
      if (/tonight/i.test(m[1])) part = part || 'tonight';
      found = true;
    } else if (take(/\b(?:this\s+|next\s+)?weekend\b/i)) {
      base = addDays(startOfDay(now), (6 - now.getDay() + 7) % 7);
      found = true;
    } else if (take(/\bnext\s+week\b/i)) {
      base = addDays(startOfDay(now), 7);
      found = true;
    } else if (take(/\bnext\s+month\b/i)) {
      base = addMonths(startOfDay(now), 1);
      found = true;
    } else if (take(/\bend\s+of\s+(?:the\s+)?month\b/i)) {
      base = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      found = true;
    } else if (take(/\bend\s+of\s+(?:the\s+)?week\b/i)) {
      base = addDays(startOfDay(now), (5 - now.getDay() + 7) % 7);
      found = true;
    } else if ((m = take(new RegExp(`\\b(?:(next|this|coming|on)\\s+)?(${WDLIST})\\b`, 'i')))) {
      const listed = weekdays(m[2]);
      const firstWord = new RegExp(WD, 'i').exec(m[2])[0];
      wdTarget = wdIdx(firstWord);
      if (listed.length > 1) notes.push({ level: 'warn', text: `Several days were given, so only ${firstWord} was used. To repeat on several days say “every Mon, Wed”.` });
      base = addDays(startOfDay(now), (wdTarget - now.getDay() + 7) % 7);
      if ((m[1] || '').toLowerCase() === 'next') {
        // "next friday" = the friday in next week (weeks start on Monday)
        const nextMonday = addDays(startOfDay(now), (8 - now.getDay()) % 7 || 7);
        if (base < nextMonday) base = addDays(base, 7);
      }
      weekdayBased = true;
      found = true;
    }
  }

  // ---- numeric dates: "3/5", "10/9", "the 15th". A day word wins; fractions and "5th floor" are left alone. ----
  const slashRe = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b(?!\s*(?:cups?|tsp|tbsp|lbs?|oz|inch(?:es)?|kg|g|ml|l|liters?|miles?|of)\b)/i;
  if (!base) {
    if ((m = take(slashRe))) {
      let y = m[3] ? +m[3] : now.getFullYear();
      if (y < 100) y += 2000;
      base = mkDate(y, +m[1] - 1, +m[2]);
      if (!base) badDate = true;
      yearless = !m[3];
      found = true;
    } else if ((m = take(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b(?!\s+(?:floor|step|time|place|street|st|avenue|ave|grade|row|chapter|page|team|person|group|session)\b)/i))) {
      base = { dom: +m[1] };
      found = true;
    }
  } else if (weekdayBased && wdTarget >= 0 && (m = slashRe.exec(rest)) && !m[3]) {
    // "Friday 10/9": use the date when it really is that weekday, otherwise leave the numbers in the title
    for (const y of [now.getFullYear(), now.getFullYear() + 1]) {
      const cand = mkDate(y, +m[1] - 1, +m[2]);
      if (cand && cand.getDay() === wdTarget && startOfDay(cand) >= startOfDay(now)) {
        take(slashRe);
        base = cand;
        weekdayBased = false;
        break;
      }
    }
    if (weekdayBased) notes.push({ level: 'warn', text: `Ignored “${m[0]}” because it is not a ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][wdTarget]}.` });
  }

  // ---- named times that always count: noon, midnight, tonight, end of day ----
  if ((m = take(/\b(noon|midday|midnight|eod|cob|tonight)\b/i))) {
    part = part || m[1].toLowerCase();
    found = true;
  } else if (take(/\bend\s+of\s+(?:the\s+)?day\b/i)) {
    part = part || 'eod';
    found = true;
  }

  // ---- clock time ----
  const pmish = !!part && PM_PARTS.includes(part);
  const hour12 = (h, mi) => {
    // a bare "at 3" / "3:30": the part of day decides am/pm, otherwise 1-6 = pm and 7-11 = am (and it is flagged)
    if (h === 12 || h === 0 || h >= 13) return [h, mi];
    if (pmish) return [h + 12, mi];
    if (part === 'morning') return [h, mi];
    const hh = h <= 6 ? h + 12 : h;
    guessed = fmtTime(hh, mi);
    return [hh, mi];
  };
  if (!time) {
    if ((m = take(/(?:\bat\s+|@\s*|(^|[^\d.:]))(\d{1,2})(?:[:.]([0-5]\d))?\s*([ap])(?:m|\.m\.?)(?![a-z])/i))) {
      const h = +m[2];
      const mi = m[3] ? +m[3] : 0;
      if (h >= 1 && h <= 12) time = [to24(h, m[4]), mi];
      else if (h >= 13 && h <= 23) time = [h, mi];
      else rest += ' ' + m[0].trim();
      if (time) {
        found = true;
        clockGiven = true;
      }
    } else if ((m = take(/\b(?:at\s+)?(1[3-9]|2[0-3]|0\d)\.([0-5]\d)\b/))) {
      time = [+m[1], +m[2]];
      found = true;
      clockGiven = true;
    } else if ((m = take(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/))) {
      const h = +m[1];
      const twentyFour = h === 0 || h >= 13 || (m[1].length === 2 && m[1][0] === '0');
      time = twentyFour ? [h, +m[2]] : hour12(h, +m[2]);
      found = true;
      clockGiven = true;
    } else if ((m = take(/\bat\s+(\d{1,2})\b(?!\s*(?:%|\/|-|:))/i))) {
      const h = +m[1];
      if (h <= 23) {
        time = h >= 1 && h <= 12 ? hour12(h, 0) : [h, 0];
        found = true;
        clockGiven = true;
      } else {
        rest += ` at ${m[1]}`; // not a time
      }
    }
  }
  if (!time && part && PARTS[part]) time = PARTS[part];
  const timeUnderstood = !!time || !!abs;

  // ---- assemble ----
  let due;
  let dateUnderstood = true;
  const dateGiven = !!abs || !!base;
  if (abs && (base || clockGiven)) notes.push({ level: 'warn', text: 'Both “in …” and another date or time were given, so only “in …” was used.' });
  const t0 = time || [def.h, def.m];
  if (abs) {
    due = abs;
  } else {
    if (base && base.dom !== undefined) {
      const dom = base.dom;
      let d = new Date(now.getFullYear(), now.getMonth(), dom);
      if (d.getDate() !== dom || (time ? at(d, t0[0], t0[1]) <= now : d < startOfDay(now))) {
        d = new Date(now.getFullYear(), now.getMonth() + 1, dom);
        if (d.getDate() !== dom) d = new Date(now.getFullYear(), now.getMonth() + 2, dom);
        notes.push({ level: 'info', text: `The ${dom}${['th', 'st', 'nd', 'rd'][dom % 10 > 3 || Math.floor(dom / 10) === 1 ? 0 : dom % 10]} has passed, so the next one was used.` });
      }
      base = d;
    }
    if (!base) {
      if (repeat && repeat.byday) {
        // first matching weekday from today (today only if that time is still ahead)
        for (let i = 0; i < 8 && !base; i++) {
          const d = addDays(startOfDay(now), i);
          if (repeat.byday.includes(BYDAY[d.getDay()]) && at(d, t0[0], t0[1]) > now) base = d;
        }
      } else if (time || (repeat && repeat.freq === 'DAILY')) {
        base = startOfDay(now);
        implicitToday = true;
      }
    }
    if (!base) {
      base = addDays(startOfDay(now), 1);
      dateUnderstood = false;
      notes.push({ level: 'warn', text: badDate ? 'That date is not valid, so it was set to tomorrow. Check the date.' : 'No date found, so it was set to tomorrow. Check the date.' });
    } else if (badDate && !abs) {
      notes.push({ level: 'warn', text: 'Ignored a date that does not exist.' });
    }
    due = at(base, t0[0], t0[1]);
    if (implicitToday && due <= now) due = addDays(due, 1); // "at 8am" after 8am means tomorrow
    if (weekdayBased && due <= now) due = addDays(due, 7); // "friday" on a friday after the time means next week
    if (yearless && (time ? due <= now : startOfDay(due) < startOfDay(now))) {
      due = new Date(due.getFullYear() + 1, due.getMonth(), due.getDate(), t0[0], t0[1]);
      notes.push({ level: 'info', text: 'That date has passed this year, so next year was used.' });
    }
  }
  if (!isPlausible(due)) {
    due = at(addDays(startOfDay(now), 1), def.h, def.m);
    dateUnderstood = false;
    notes.push({ level: 'warn', text: 'That date is out of range, so it was set to tomorrow. Check the date.' });
  }

  if (!timeUnderstood && dateUnderstood) notes.push({ level: 'info', text: `No time given, so ${fmtTime(def.h, def.m)} was used.` });
  if (guessed) notes.push({ level: 'warn', text: `No am/pm given, so the time was read as ${guessed}.` });
  if (due < now) notes.push({ level: 'warn', text: 'That time has already passed.' });
  if (repeat && repeat.freq === 'WEEKLY' && !repeat.byday) repeat.byday = [BYDAY[due.getDay()]];
  if (durationMin !== null && !(durationMin >= 1 && durationMin <= MAX_DURATION_MIN)) durationMin = null;

  // ---- title / description ----
  const lead = /^(?:(?:on|at|by|for|from|until|till|due|the|every|in|@|-|—|–|,|\.|:|;)\s+)+/i;
  const tail = /(?:\s+(?:on|at|by|for|from|until|till|due|the|every|in|@|-|—|–|,|\.|:|;))+$/i;
  const tidy = (s) => {
    for (let i = 0, prev = ''; i < 5 && prev !== s; i++) {
      prev = s;
      s = s.replace(lead, '').replace(tail, '').replace(/^[\s,.\-—–:;]+|[\s,.\-—–:;]+$/g, '');
    }
    return s;
  };
  const [first, ...more] = rest
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s*[.;]\s+|\s+[-–—]\s+/)
    .map(tidy)
    .filter(Boolean);
  let title = (first || '').trim();
  if (/^[a-z]/.test(title)) title = title[0].toUpperCase() + title.slice(1);
  const fitted = fitTitle(title, more.join('. '));

  return {
    title: fitted.title,
    description: fitted.description,
    due,
    durationMin,
    repeat,
    cat,
    dateUnderstood,
    dateGiven,
    timeUnderstood,
    foundWhen: found,
    notes,
  };
}

/** Parse one task. Never returns an empty title. */
export function parseLocal(text, now = new Date(), opts = {}) {
  const r = parseChunk(text, now, opts);
  if (!r.title) {
    const f = fitTitle(String(text).trim());
    r.title = f.title || String(text).trim().slice(0, 80);
    if (f.description) r.description = [f.description, r.description].filter(Boolean).join('. ');
  }
  return r;
}

export const MAX_TASKS_PER_MESSAGE = 20;

/**
 * Parse a message that may hold several tasks: one per line / semicolon, or comma-separated when at
 * least two of the comma pieces contain a date or time ("dentist fri 3pm, groceries sat, call mom tonight").
 */
const MAX_CHARS = 5000;
const FRAGMENT = new RegExp(`^(?:(?:and|or|&|then|on|at|the|to|,|/)\\s*|${WD}\\s*|${WDP}\\s*)+$`, 'i');

export function parseAll(text, now = new Date(), opts = {}) {
  let src = String(text);
  const truncated = src.length > MAX_CHARS;
  if (truncated) src = src.slice(0, MAX_CHARS);
  const lines = src
    .split(/\r?\n|;\s+|;$/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    const guarded = line
      // "Oct 20, 2026" and "every monday, wednesday" must not be split at the comma
      .replace(new RegExp(`(${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?),(\\s*\\d{4})`, 'gi'), '$1$2')
      .replace(new RegExp(`((?:every|each)\\s+${WD}(?:\\s*,\\s*${WD})*)`, 'gi'), (s) => s.replace(/,/g, '\u0001'));
    const parts = guarded.split(/\s*,\s*/).map((s) => s.replace(/\u0001/g, ','));
    let chunks = [line];
    if (parts.length > 1 && parts.filter((p) => parseChunk(p, now, opts).foundWhen).length >= 2) {
      chunks = [];
      for (const p of parts) {
        const title = parseChunk(p, now, opts).title;
        if ((!title || FRAGMENT.test(title)) && chunks.length) chunks[chunks.length - 1] += ', ' + p; // "Dentist, Friday, 3pm" and "Gym mon, wed and fri 6pm" stay one task
        else chunks.push(p);
      }
    }
    for (const c of chunks) out.push(parseLocal(c, now, opts));
  }
  if (truncated && out.length) out[out.length - 1].notes.push({ level: 'warn', text: `Only the first ${MAX_CHARS} characters were used.` });
  if (out.length > MAX_TASKS_PER_MESSAGE) {
    const extra = out.length - MAX_TASKS_PER_MESSAGE;
    out.length = MAX_TASKS_PER_MESSAGE;
    out[out.length - 1].notes.push({ level: 'warn', text: `Only the first ${MAX_TASKS_PER_MESSAGE} tasks were added; ${extra} more were left out. Send them again.` });
  }
  return out;
}
