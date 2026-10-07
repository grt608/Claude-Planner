// Builds an iCalendar (RFC 5545) file. Every event carries a display alarm
// `lead` minutes before the start, so Apple Calendar fires a native iPhone
// notification even when this web app is closed.

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
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      out.push(cur);
      cur = ' ';
      bytes = 1;
      limit = 75;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

export function buildICS(tasks, { lead = 30, minutes = 30, now = new Date() } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Claude Planner//EN', 'CALSCALE:GREGORIAN'];
  for (const t of tasks) {
    const start = new Date(t.due);
    const end = new Date(start.getTime() + minutes * 60000);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${t.uid || t.id}@claude-planner`,
      `DTSTAMP:${utc(now)}`,
      `DTSTART:${floating(start)}`,
      `DTEND:${floating(end)}`,
      `SUMMARY:${escapeText(t.title)}`,
    );
    if (t.description) lines.push(`DESCRIPTION:${escapeText(t.description)}`);
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(t.title)}`,
      `TRIGGER:-PT${lead}M`,
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
