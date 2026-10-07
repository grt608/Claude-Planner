// Repeat rules ("every Monday", "every 2 weeks", ...) evaluated in local time.
// A repeat is { freq: 'DAILY'|'WEEKLY'|'MONTHLY'|'YEARLY', interval, byday?: ['MO', ...] } (byday only for WEEKLY).
// A task's current occurrence is task.due. Optional task.anchor is the date/time the series started with; the
// pattern (time of day, day of month, week phase) always comes from it, so a daylight-saving gap or a one-off
// move of the current occurrence can never shift the whole series.
import { BYDAY } from './parse.js';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR'];
const weekIdx = (code) => (BYDAY.indexOf(code) + 6) % 7; // Monday = 0
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const withTime = (day, pattern) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), pattern.getHours(), pattern.getMinutes(), 0, 0);

/** A normalised copy of a repeat rule, or null if it is not a usable rule. */
export function cleanRepeat(r) {
  if (!r || typeof r !== 'object') return null;
  const freq = String(r.freq || '').toUpperCase();
  const interval = Math.floor(Number(r.interval) || 1);
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq) || interval < 1 || interval > 99) return null;
  const out = { freq, interval };
  if (freq === 'WEEKLY' && Array.isArray(r.byday)) {
    const days = [...new Set(r.byday.map((d) => String(d).toUpperCase()).filter((d) => BYDAY.includes(d)))].sort((a, b) => weekIdx(a) - weekIdx(b));
    if (days.length) out.byday = days;
  }
  return out;
}

export const isValidRepeat = (r) => cleanRepeat(r) !== null;

export function describeRepeat(r) {
  if (!r) return '';
  const n = r.interval || 1;
  if (r.freq === 'WEEKLY' && r.byday) {
    const same = (a) => a.length === r.byday.length && a.every((d) => r.byday.includes(d));
    if (n === 1 && same(WEEKDAYS)) return 'Weekdays';
    const names = [...r.byday].sort((a, b) => weekIdx(a) - weekIdx(b)).map((d) => DAY_NAMES[BYDAY.indexOf(d)]).join(', ');
    return n === 1 ? `Weekly on ${names}` : `Every ${n} weeks on ${names}`;
  }
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[r.freq];
  const adverb = { DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', YEARLY: 'Yearly' }[r.freq];
  return n === 1 ? adverb : `Every ${n} ${unit}s`;
}

export function rruleOf(r) {
  const parts = [`FREQ=${r.freq}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.freq === 'WEEKLY' && r.byday && r.byday.length) parts.push(`BYDAY=${[...new Set(r.byday)].join(',')}`);
  return parts.join(';');
}

// Menu keys used by the edit screen.
export function repeatKey(r) {
  if (!r) return 'none';
  if ((r.interval || 1) !== 1) return 'custom';
  if (r.freq === 'DAILY') return 'daily';
  if (r.freq === 'MONTHLY') return 'monthly';
  if (r.freq === 'YEARLY') return 'yearly';
  if (r.freq === 'WEEKLY') {
    if (r.byday && r.byday.length === 5 && WEEKDAYS.every((d) => r.byday.includes(d))) return 'weekdays';
    if (!r.byday || r.byday.length === 1) return 'weekly';
  }
  return 'custom';
}

export function repeatFromKey(key, due) {
  const d = new Date(due);
  switch (key) {
    case 'daily': return { freq: 'DAILY', interval: 1 };
    case 'weekdays': return { freq: 'WEEKLY', interval: 1, byday: [...WEEKDAYS] };
    case 'weekly': return { freq: 'WEEKLY', interval: 1, byday: [BYDAY[d.getDay()]] };
    case 'monthly': return { freq: 'MONTHLY', interval: 1 };
    case 'yearly': return { freq: 'YEARLY', interval: 1 };
    default: return null;
  }
}

// The pattern's occurrences in order, starting at (or before) the pattern anchor.
function* pattern(pat, r) {
  const n = Math.max(1, r.interval || 1);
  if (r.freq === 'DAILY') {
    for (let k = 0; k < 60000; k++) {
      const day = startOfDay(pat);
      day.setDate(day.getDate() + k * n);
      yield withTime(day, pat);
    }
  } else if (r.freq === 'WEEKLY') {
    const wanted = [...new Set((r.byday && r.byday.length ? r.byday : [BYDAY[pat.getDay()]]).map(weekIdx))].sort((a, b) => a - b);
    const monday = startOfDay(pat);
    monday.setDate(monday.getDate() - ((pat.getDay() + 6) % 7));
    for (let k = 0; k < 9000; k++) {
      for (const off of wanted) {
        const day = new Date(monday);
        day.setDate(day.getDate() + k * 7 * n + off);
        const at = withTime(day, pat);
        if (at >= pat) yield at;
      }
    }
  } else if (r.freq === 'MONTHLY') {
    for (let k = 0; k < 4000; k++) {
      const at = new Date(pat.getFullYear(), pat.getMonth() + k * n, pat.getDate(), pat.getHours(), pat.getMinutes());
      if (at.getDate() === pat.getDate()) yield at; // months without that day are skipped, like Calendar does
    }
  } else if (r.freq === 'YEARLY') {
    for (let k = 0; k < 600; k++) {
      const at = new Date(pat.getFullYear() + k * n, pat.getMonth(), pat.getDate(), pat.getHours(), pat.getMinutes());
      if (at.getMonth() === pat.getMonth()) yield at; // Feb 29 skips non-leap years
    }
  }
}

// Every occurrence from the current one (task.due) onward. If task.due is off the pattern it still comes
// first, like DTSTART in an iCalendar series.
function* series(task) {
  const start = new Date(task.due);
  const pat = new Date(task.anchor || task.due);
  let first = true;
  for (const d of pattern(pat, task.repeat)) {
    if (d < start) continue;
    if (first) {
      first = false;
      if (+d !== +start) yield start;
    }
    yield d;
  }
}

/** Occurrences with from <= date <= to (at most `limit`). Non-repeating tasks give [due] if it is in range. */
export function occurrences(task, from, to, limit = 3000) {
  const out = [];
  if (!task.repeat) {
    const d = new Date(task.due);
    return d >= from && d <= to ? [d] : [];
  }
  for (const d of series(task)) {
    if (d > to || out.length >= limit) break;
    if (d >= from) out.push(d);
  }
  return out;
}

/** First occurrence strictly after `after`, or null for non-repeating tasks. */
export function nextOccurrence(task, after) {
  if (!task.repeat) return null;
  for (const d of series(task)) if (d > after) return d;
  return null;
}
