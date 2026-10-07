// Builds an iCalendar (RFC 5545) file. Every event carries display alarms before the start, so Apple
// Calendar fires a native iPhone notification even when this web app is closed.
import { rruleOf } from './recur.js';

const pad = (n) => String(n).padStart(2, '0');
const floating = (d) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const utc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export const escapeText = (s) =>
  String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

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

/**
 * tasks: [{ id, uid?, title, description?, due, duration?, repeat? }]
 * opts: { lead = 30, alerts = [lead, ...], minutes = default duration, now }
 */
export function buildICS(tasks, { lead = 30, alerts, minutes = 30, now = new Date() } = {}) {
  const alarmMinutes = [...new Set((alerts && alerts.length ? alerts : [lead]).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 40320))].sort((a, b) => a - b);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Claude Planner//EN', 'CALSCALE:GREGORIAN'];
  for (const t of tasks) {
    const start = new Date(t.due);
    const end = new Date(start.getTime() + (t.duration > 0 ? t.duration : minutes) * 60000);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${t.uid || t.id}@claude-planner`,
      `DTSTAMP:${utc(now)}`,
      `DTSTART:${floating(start)}`,
      `DTEND:${floating(end)}`,
    );
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
