// Repeat rules ("every Monday", "every 2 weeks", ...) evaluated in local time.
// A repeat is { freq: 'DAILY'|'WEEKLY'|'MONTHLY'|'YEARLY', interval, byday?: ['MO', ...] }.
// A task's series starts at task.due and never produces earlier dates.
import { BYDAY } from './parse.js';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR'];
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const withTime = (day, anchor) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), anchor.getHours(), anchor.getMinutes(), 0, 0);

export function isValidRepeat(r) {
  return !!r && ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(r.freq) && Number.isInteger(r.interval) && r.interval >= 1 && r.interval <= 99 &&
    (r.byday === undefined || (Array.isArray(r.byday) && r.byday.length > 0 && r.byday.every((d) => BYDAY.includes(d))));
}

export function describeRepeat(r) {
  if (!r) return '';
  const n = r.interval || 1;
  if (r.freq === 'WEEKLY' && r.byday) {
    const same = (a) => a.length === r.byday.length && a.every((d) => r.byday.includes(d));
    if (n === 1 && same(WEEKDAYS)) return 'Weekdays';
    const names = r.byday.map((d) => DAY_NAMES[BYDAY.indexOf(d)]).join(', ');
    return n === 1 ? `Weekly on ${names}` : `Every ${n} weeks on ${names}`;
  }
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[r.freq];
  const adverb = { DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', YEARLY: 'Yearly' }[r.freq];
  return n === 1 ? adverb : `Every ${n} ${unit}s`;
}

export function rruleOf(r) {
  const parts = [`FREQ=${r.freq}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.byday && r.byday.length) parts.push(`BYDAY=${r.byday.join(',')}`);
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

// Every occurrence of the series in order, starting at the anchor (task.due).
function* series(task) {
  const anchor = new Date(task.due);
  const r = task.repeat;
  const n = Math.max(1, r.interval || 1);
  if (r.freq === 'DAILY') {
    for (let k = 0; k < 40000; k++) {
      const day = startOfDay(anchor);
      day.setDate(day.getDate() + k * n);
      yield withTime(day, anchor);
    }
  } else if (r.freq === 'WEEKLY') {
    const wanted = (r.byday && r.byday.length ? r.byday : [BYDAY[anchor.getDay()]])
      .map((d) => (BYDAY.indexOf(d) + 6) % 7) // offset from Monday
      .sort((a, b) => a - b);
    const monday = startOfDay(anchor);
    monday.setDate(monday.getDate() - ((anchor.getDay() + 6) % 7));
    for (let k = 0; k < 6000; k++) {
      for (const off of wanted) {
        const day = new Date(monday);
        day.setDate(day.getDate() + k * 7 * n + off);
        const at = withTime(day, anchor);
        if (at >= anchor) yield at;
      }
    }
  } else if (r.freq === 'MONTHLY') {
    for (let k = 0; k < 3000; k++) {
      const at = new Date(anchor.getFullYear(), anchor.getMonth() + k * n, anchor.getDate(), anchor.getHours(), anchor.getMinutes());
      if (at.getDate() === anchor.getDate()) yield at; // months without that day are skipped, like Calendar does
    }
  } else if (r.freq === 'YEARLY') {
    for (let k = 0; k < 500; k++) {
      const at = new Date(anchor.getFullYear() + k * n, anchor.getMonth(), anchor.getDate(), anchor.getHours(), anchor.getMinutes());
      if (at.getMonth() === anchor.getMonth()) yield at; // Feb 29 skips non-leap years
    }
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
