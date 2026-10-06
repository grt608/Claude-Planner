// Pure helpers for the 12-month overview.
export const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function countByDay(tasks) {
  const map = {};
  for (const t of tasks) {
    if (t.done) continue;
    const k = dayKey(new Date(t.due));
    map[k] = (map[k] || 0) + 1;
  }
  return map;
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
