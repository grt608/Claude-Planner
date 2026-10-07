// Builds an iCalendar (RFC 5545) file. Every event carries display alarms before the start, so Apple
// Calendar fires a native iPhone notification even when this web app is closed.
import { rruleOf } from './recur.js';
import { MAX_DURATION_MIN, isPlausible } from './parse.js';

const pad = (n) => String(n).padStart(2, '0');
// Floating times are plain wall-clock numbers. They are handled as UTC timestamps here so daylight-saving
// changes in the device's zone can never move them (e.g. a 02:30 that does not exist locally on one day).
const fmtWall = (ms) => {
  const u = new Date(ms);
  return `${String(u.getUTCFullYear()).padStart(4, '0')}${pad(u.getUTCMonth() + 1)}${pad(u.getUTCDate())}T${pad(u.getUTCHours())}${pad(u.getUTCMinutes())}00`;
};
const utc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export const escapeText = (s) =>
  String(s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') // control characters (keeps tab, CR, LF for the next step)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');

// Fold to <=75 octets per line without splitting a UTF-8 character.
export function fold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > 75) {
      out.push(cur);
      cur = ' ';
      bytes = 1;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

// Minutes before the start -> an iCalendar duration ("-PT30M", "-PT1H", "-P1D").
export function trigger(min) {
  if (min % 1440 === 0) return `-P${min / 1440}D`;
  if (min % 60 === 0) return `-PT${min / 60}H`;
  return `-PT${min}M`;
}

/** Wall-clock start (as a UTC-timestamp of the local fields): the occurrence's date at the series' own time of day. */
function wallStart(t) {
  const d = new Date(t.due);
  if (!isPlausible(d)) return NaN;
  let h = d.getHours();
  let mi = d.getMinutes();
  if (t.repeat && t.anchor) {
    const a = new Date(t.anchor);
    if (isPlausible(a)) {
      h = a.getHours();
      mi = a.getMinutes();
    }
  }
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), h, mi);
}

/**
 * tasks: [{ id, uid?, title, description?, due, duration?, repeat?, anchor? }]
 * opts: { lead = 30, alerts = [lead, ...], minutes = default duration, now }
 * Tasks that cannot be written as a valid event (bad or out-of-range dates) are left out.
 */
export function buildICS(tasks, { lead = 30, alerts, minutes = 30, now = new Date() } = {}) {
  const alarmMinutes = [...new Set((alerts && alerts.length ? alerts : [lead]).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 40320))].sort((a, b) => a - b);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Claude Planner//EN', 'CALSCALE:GREGORIAN'];
  for (const t of tasks) {
    const start = wallStart(t);
    const dur = Number.isFinite(t.duration) && t.duration > 0 && t.duration <= MAX_DURATION_MIN ? t.duration : minutes;
    const end = start + dur * 60000;
    if (!Number.isFinite(start) || new Date(end).getUTCFullYear() > 2200) continue;
    const uid = String(t.uid || t.id).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
    lines.push('BEGIN:VEVENT', `UID:${uid}@claude-planner`, `DTSTAMP:${utc(now)}`, `DTSTART:${fmtWall(start)}`, `DTEND:${fmtWall(end)}`);
    if (t.repeat) lines.push(`RRULE:${rruleOf(t.repeat)}`);
    lines.push(`SUMMARY:${escapeText(t.title)}`);
    if (t.description) lines.push(`DESCRIPTION:${escapeText(t.description)}`);
    for (const min of alarmMinutes) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(t.title)}`, `TRIGGER:${trigger(min)}`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
