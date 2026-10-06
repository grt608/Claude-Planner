// Offline fallback parser used when no API key is set or the AI call fails.
// Handles: today/tomorrow, weekday names, "next <weekday>", YYYY-MM-DD, M/D, "at 3pm" / "15:30".

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function parseLocal(text, now = new Date()) {
  let rest = text.trim();
  let date = null;
  let hour = null;
  let minute = 0;

  const strip = (re) => {
    const m = rest.match(re);
    if (m) rest = rest.replace(m[0], ' ');
    return m;
  };

  let m;
  if ((m = strip(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/))) {
    date = new Date(+m[1], +m[2] - 1, +m[3]);
  } else if ((m = strip(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    let y = m[3] ? +m[3] : now.getFullYear();
    if (y < 100) y += 2000;
    date = new Date(y, +m[1] - 1, +m[2]);
    if (!m[3] && date < startOfDay(now)) date.setFullYear(y + 1);
  } else if (strip(/\btomorrow\b/i)) {
    date = addDays(startOfDay(now), 1);
  } else if (strip(/\btoday\b/i)) {
    date = startOfDay(now);
  } else if ((m = strip(/\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i))) {
    const target = DAYS.indexOf(m[2].toLowerCase());
    let diff = (target - now.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    date = addDays(startOfDay(now), diff);
  }

  if ((m = strip(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i))) {
    hour = +m[1] % 12 + (m[3].toLowerCase() === 'pm' ? 12 : 0);
    minute = m[2] ? +m[2] : 0;
  } else if ((m = strip(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/))) {
    hour = +m[1];
    minute = +m[2];
  }

  if (!date) {
    date = startOfDay(now);
    if (hour === null) date = addDays(date, 1); // no clue at all: tomorrow
  }
  if (hour === null) hour = 9;
  date.setHours(hour, minute, 0, 0);
  // Time only ("at 8am") that already passed today means tomorrow.
  if (date <= now && !/\b(today|\d{4}-|\d\/)/i.test(text)) date = addDays(date, 1);

  const cleaned = rest.replace(/\s+/g, ' ').replace(/^[\s,.\-:]+|[\s,.\-:]+$/g, '');
  const [title, ...more] = cleaned.split(/[.;]\s+|\s+-\s+/);
  return {
    title: (title || text.trim()).slice(0, 80),
    description: more.join('. '),
    due: date,
  };
}

export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
