// Pure helpers for the 12-month overview.
import { occurrences } from './recur.js';

export const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Tasks per day. With from/to, repeating tasks are expanded into every occurrence in that range. */
export function countByDay(tasks, from, to) {
  const map = {};
  const bump = (k) => (map[k] = (map[k] || 0) + 1);
  for (const t of tasks) {
    if (t.done) continue;
    if (t.repeat && from && to) occurrences(t, from, to).forEach((d) => bump(dayKey(d)));
    else bump(dayKey(new Date(t.due)));
  }
  return map;
}

/** [{ task, at }] for one day key ("YYYY-MM-DD"), expanding repeats; sorted by time. */
export function tasksOnDay(tasks, key) {
  const [y, m, d] = key.split('-').map(Number);
  const from = new Date(y, m - 1, d);
  const to = new Date(y, m - 1, d, 23, 59, 59, 999);
  const out = [];
  for (const t of tasks) {
    if (t.repeat) {
      if (t.done) continue;
      occurrences(t, from, to).forEach((at) => out.push({ task: t, at }));
    } else if (dayKey(new Date(t.due)) === key) {
      out.push({ task: t, at: new Date(t.due) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** 12 months starting from `from`'s month; each has weeks (arrays of 7 Date|null, Sunday first). */
export function buildYear(from = new Date()) {
  const months = [];
  for (let i = 0; i < 12; i++) {
    const first = new Date(from.getFullYear(), from.getMonth() + i, 1);
    const daysIn = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const cells = Array(first.getDay()).fill(null);
    for (let d = 1; d <= daysIn; d++) cells.push(new Date(first.getFullYear(), first.getMonth(), d));
    while (cells.length % 7) cells.push(null);
    const weeks = [];
    for (let w = 0; w < cells.length; w += 7) weeks.push(cells.slice(w, w + 7));
    months.push({ first, weeks });
  }
  return months;
}
