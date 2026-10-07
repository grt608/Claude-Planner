// Free, offline natural-language task parser.
//
// parseLocal(text, now, opts) -> one task; parseAll(text, now, opts) -> one or more tasks.
// A task is { title, description, due: Date, durationMin: number|null, repeat: object|null, cat: string,
//             dateUnderstood, timeUnderstood, foundWhen, notes: [{level:'warn'|'info', text}] }.
// repeat is { freq: 'DAILY'|'WEEKLY'|'MONTHLY'|'YEARLY', interval: n, byday?: ['MO', ...] }.
// All arithmetic is done in the device's local time, so results do not depend on the time zone.
// opts: { defaultTime: 'HH:MM' } (default 09:00).

const WD = '(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)';
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WD_ABBR = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MON_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const FREQ = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' };

const wdIdx = (s) => WD_ABBR.indexOf(s.slice(0, 3).toLowerCase());
const monIdx = (s) => MON_ABBR.indexOf(s.slice(0, 3).toLowerCase());

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

// A calendar date, or null when it does not exist (Feb 30 would otherwise roll over into March).
function mkDate(y, mo, d) {
  const dt = new Date(y, mo, d);
  return dt.getFullYear() === y && dt.getMonth() === mo && dt.getDate() === d ? dt : null;
}

function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  return m && +m[1] < 24 && +m[2] < 60 ? { h: +m[1], m: +m[2] } : null;
}

const to24 = (h, ampm) => (h % 12) + (/^p/i.test(ampm) ? 12 : 0);
const fmtTime = (h, m) => `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;

// Parses one chunk of text. Returns the raw result (title may be empty).
function parseChunk(text, now, opts) {
  const def = parseHM(opts.defaultTime) || { h: 9, m: 0 };
  let rest = ' ' + String(text).replace(/\s+/g, ' ').trim() + ' ';
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
  let weekdayBased = false;
  let yearless = false;
  let implicitToday = false;
  let time = null; // [h, m]
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
  if ((m = take(/\bevery\s+(\d+)\s+(day|week|month|year)s?\b/i))) {
    repeat = { freq: FREQ[m[2].toLowerCase()], interval: Math.max(1, +m[1]) };
  } else if ((m = take(/\bevery\s+other\s+(day|week|month|year)\b/i))) {
    repeat = { freq: FREQ[m[1].toLowerCase()], interval: 2 };
  } else if ((m = take(/\b(?:every\s+weekday|on\s+weekdays|weekdays|(?:mon|monday)\s*(?:-|to|through|thru)\s*(?:fri|friday))(?:\s+(morning|afternoon|evening|night))?\b/i))) {
    repeat = { freq: 'WEEKLY', interval: 1, byday: ['MO', 'TU', 'WE', 'TH', 'FR'] };
    if (m[1]) part = m[1].toLowerCase();
  } else if ((m = take(new RegExp(`\\bevery\\s+(${WD}(?:\\s*(?:,|and|&)\\s*${WD})*)(?:\\s+(morning|afternoon|evening|night))?\\b`, 'i')))) {
    const days = [...m[1].matchAll(new RegExp(WD, 'gi'))].map((x) => wdIdx(x[0]));
    repeat = { freq: 'WEEKLY', interval: 1, byday: [...new Set(days)].sort((a, b) => a - b).map((i) => BYDAY[i]) };
    if (m[2]) part = m[2].toLowerCase();
  } else if ((m = take(/\b(?:on\s+)?(mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)(?:\s+(morning|afternoon|evening|night))?\b/i))) {
    repeat = { freq: 'WEEKLY', interval: 1, byday: [BYDAY[wdIdx(m[1])]] };
    if (m[2]) part = m[2].toLowerCase();
  } else if ((m = take(/\bevery\s*(day|week|month|year)\b/i))) {
    repeat = { freq: FREQ[m[1].toLowerCase()], interval: 1 };
  } else if ((m = take(/\bevery\s+(morning|afternoon|evening|night)\b/i))) {
    repeat = { freq: 'DAILY', interval: 1 };
    part = m[1].toLowerCase();
  } else if ((m = /\b(daily|weekly|monthly|yearly|annually|nightly)\b/i.exec(rest)) && m.index > 1 && take(/\b(daily|weekly|monthly|yearly|annually|nightly)\b/i)) {
    // Only after the first word: "Pay rent monthly" repeats, "Yearly check up" is just a title.
    const w = m[1].toLowerCase();
    repeat = { freq: { daily: 'DAILY', nightly: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY', annually: 'YEARLY' }[w], interval: 1 };
    if (w === 'nightly') part = 'night';
  }
  if (repeat) found = true;

  // ---- duration ----
  if ((m = take(/\bfor\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i))) {
    durationMin = Math.round(+m[1] * (/^h/i.test(m[2]) ? 60 : 1));
  } else if (take(/\bfor\s+(?:an?|one)\s+(?:hour|hr)\b/i)) {
    durationMin = 60;
  } else if (take(/\bfor\s+half\s+an?\s+hour\b/i)) {
    durationMin = 30;
  }

  // ---- time range: "2-3pm", "from 9 to 5pm", "9am - 10am" ----
  if ((m = take(/(?:\bfrom\s+|\bat\s+|\b)(\d{1,2})(?::(\d{2}))?\s*([ap](?:m|\.m\.?))?\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*([ap](?:m|\.m\.?))(?![a-z])/i))) {
    const endMer = m[6];
    let sh = to24(+m[1], m[3] || endMer);
    const sm = m[2] ? +m[2] : 0;
    const eh = to24(+m[4], endMer);
    const em = m[5] ? +m[5] : 0;
    if (!m[3] && sh * 60 + sm > eh * 60 + em) sh = to24(+m[1], /^p/i.test(endMer) ? 'am' : 'pm'); // "11-1pm" is 11am-1pm
    time = [sh, sm];
    durationMin = Math.max(5, eh * 60 + em - (sh * 60 + sm));
    found = true;
  }

  // ---- relative: "in 2 hours", "in 3 days", "in an hour", "in half an hour" ----
  if ((m = take(/\bin\s+(half\s+an?|an?|\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?)\b/i))) {
    const n = /^half/i.test(m[1]) ? 0.5 : /^an?$/i.test(m[1]) ? 1 : +m[1];
    const u = m[2].toLowerCase();
    if (u.startsWith('mi')) abs = new Date(now.getTime() + n * 60000);
    else if (u.startsWith('h')) abs = new Date(now.getTime() + n * 3600000);
    else if (u.startsWith('d')) base = addDays(startOfDay(now), Math.round(n));
    else if (u.startsWith('w')) base = addDays(startOfDay(now), Math.round(n * 7));
    else base = addMonths(startOfDay(now), Math.round(n));
    found = true;
  }

  // ---- absolute dates ----
  if (!base && !abs) {
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
    } else if ((m = take(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
      let y = m[3] ? +m[3] : now.getFullYear();
      if (y < 100) y += 2000;
      base = mkDate(y, +m[1] - 1, +m[2]);
      if (!base) badDate = true;
      yearless = !m[3];
      found = true;
    } else if ((m = take(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/i))) {
      base = { dom: +m[1] };
      found = true;
    }
  }

  // ---- "tomorrow morning", "friday evening", "this afternoon", "in the evening" ----
  const partRe = new RegExp(`\\b(this|tomorrow|tomorow|tmrw|tmr|tmw|today|in\\s+the|${WD})\\s+(morning|afternoon|evening|night)\\b`, 'i');
  if ((m = partRe.exec(rest))) {
    const prefix = m[1].toLowerCase().replace(/\s+/g, ' ');
    part = m[2].toLowerCase();
    found = true;
    const keep = prefix === 'this' || prefix === 'in the' ? ' ' : ` ${m[1]} `;
    rest = rest.slice(0, m.index) + keep + rest.slice(m.index + m[0].length);
    if (prefix === 'this' && !base && !abs) base = startOfDay(now);
  }

  // ---- day words ----
  if (!base && !abs) {
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
    } else if ((m = take(new RegExp(`\\b(?:(next|this|coming|on)\\s+)?(${WD})\\b`, 'i')))) {
      base = addDays(startOfDay(now), (wdIdx(m[2]) - now.getDay() + 7) % 7);
      if ((m[1] || '').toLowerCase() === 'next') {
        // "next friday" = the friday in next week (weeks start on Monday)
        const nextMonday = addDays(startOfDay(now), (8 - now.getDay()) % 7 || 7);
        if (base < nextMonday) base = addDays(base, 7);
      }
      weekdayBased = true;
      found = true;
    }
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
  if (!time) {
    if ((m = take(/(?:\bat\s+|@\s*|\b)(\d{1,2})(?::(\d{2}))?\s*([ap])(?:m|\.m\.?)(?![a-z])/i))) {
      time = [to24(+m[1], m[3]), m[2] ? +m[2] : 0];
      found = true;
    } else if ((m = take(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/))) {
      let h = +m[1];
      const mi = +m[2];
      const twentyFour = h === 0 || h >= 13 || (m[1].length === 2 && m[1][0] === '0');
      if (!twentyFour) {
        if (h <= 6) h += 12; // "3:30" -> 3:30 PM, "9:30" -> 9:30 AM
        guessed = fmtTime(h, mi);
      }
      time = [h, mi];
      found = true;
    } else if ((m = take(/\bat\s+(\d{1,2})\b(?!\s*(?:%|\/|-|:))/i))) {
      const h = +m[1];
      if (h >= 13 && h <= 23) {
        time = [h, 0];
      } else if (h >= 1 && h <= 12) {
        const hh = h >= 7 && h <= 11 ? h : h === 12 ? 12 : h + 12;
        time = [hh, 0];
        guessed = fmtTime(hh, 0);
      } else {
        rest += ` at ${m[1]}`; // not a time
      }
      found = found || !!time;
    }
  }
  if (!time && part && PARTS[part]) time = PARTS[part];
  const timeUnderstood = !!time || !!abs;

  // ---- assemble ----
  let due;
  let dateUnderstood = true;
  if (abs) {
    due = abs;
  } else {
    const t0 = time || [def.h, def.m];
    if (base && base.dom !== undefined) {
      const dom = base.dom;
      let d = new Date(now.getFullYear(), now.getMonth(), dom);
      if (d.getDate() !== dom || at(d, t0[0], t0[1]) <= now) {
        d = new Date(now.getFullYear(), now.getMonth() + 1, dom);
        if (d.getDate() !== dom) d = new Date(now.getFullYear(), now.getMonth() + 2, dom);
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
      } else {
        base = addDays(startOfDay(now), 1);
        dateUnderstood = false;
        notes.push({ level: 'warn', text: badDate ? 'That date does not exist, so it was set to tomorrow. Check the date.' : 'No date found, so it was set to tomorrow. Check the date.' });
      }
    }
    due = at(base, t0[0], t0[1]);
    if (implicitToday && due <= now) due = addDays(due, 1); // "at 8am" after 8am means tomorrow
    if (weekdayBased && due <= now) due = addDays(due, 7); // "friday" on a friday after the time means next week
    if (yearless && due <= now) due = new Date(due.getFullYear() + 1, due.getMonth(), due.getDate(), t0[0], t0[1]);
  }

  if (!timeUnderstood && dateUnderstood) notes.push({ level: 'info', text: `No time given, so ${fmtTime(def.h, def.m)} was used.` });
  if (guessed) notes.push({ level: 'warn', text: `No am/pm given, so the time was read as ${guessed}.` });
  if (due < now) notes.push({ level: 'warn', text: 'That time has already passed.' });
  if (repeat && repeat.freq === 'WEEKLY' && !repeat.byday) repeat.byday = [BYDAY[due.getDay()]];

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

  return {
    title: title.slice(0, 80),
    description: more.join('. ').trim(),
    due,
    durationMin,
    repeat,
    cat,
    dateUnderstood,
    timeUnderstood,
    foundWhen: found,
    notes,
  };
}

/** Parse one task. Never returns an empty title. */
export function parseLocal(text, now = new Date(), opts = {}) {
  const r = parseChunk(text, now, opts);
  if (!r.title) r.title = String(text).trim().slice(0, 80);
  return r;
}

/**
 * Parse a message that may hold several tasks: one per line / semicolon, or comma-separated when at
 * least two of the comma pieces contain a date or time ("dentist fri 3pm, groceries sat, call mom tonight").
 */
export function parseAll(text, now = new Date(), opts = {}) {
  const lines = String(text)
    .split(/\r?\n|;\s+|;$/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    const guarded = line
      // "Oct 20, 2026" and "every monday, wednesday" must not be split at the comma
      .replace(new RegExp(`(${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?),(\\s*\\d{4})`, 'gi'), '$1$2')
      .replace(new RegExp(`(every\\s+${WD}(?:\\s*,\\s*${WD})*)`, 'gi'), (s) => s.replace(/,/g, '\u0001'));
    const parts = guarded.split(/\s*,\s*/).map((s) => s.replace(/\u0001/g, ','));
    let chunks = [line];
    if (parts.length > 1 && parts.filter((p) => parseChunk(p, now, opts).foundWhen).length >= 2) {
      chunks = [];
      for (const p of parts) {
        if (!parseChunk(p, now, opts).title && chunks.length) chunks[chunks.length - 1] += ' ' + p; // "Dentist, Friday, 3pm" stays one task
        else chunks.push(p);
      }
    }
    for (const c of chunks) out.push(parseLocal(c, now, opts));
  }
  return out.slice(0, 20);
}
