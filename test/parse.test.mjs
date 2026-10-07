import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseLocal, parseAll } from '../docs/parse.js';
import { isValidRepeat } from '../docs/recur.js';

const NOW = new Date(2026, 9, 6, 22, 5); // Tue 2026-10-06 22:05 local
const pad = (n) => String(n).padStart(2, '0');
const ls = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const rep = (r) => (r ? { freq: r.freq, interval: r.interval, byday: r.byday || null } : null);

// 170 cases written independently by four authors from a behaviour spec (they never saw the code).
const oracle = JSON.parse(fs.readFileSync(new URL('./oracle-cases.json', import.meta.url), 'utf8'));
test('independent oracle cases', () => {
  const failures = [];
  for (const c of oracle) {
    const got = parseAll(c.input, NOW);
    if (got.length !== c.expect.length) {
      failures.push(`${c.input}: ${got.length} tasks, expected ${c.expect.length}`);
      continue;
    }
    c.expect.forEach((e, i) => {
      const g = got[i];
      const same =
        g.title === e.title &&
        ls(g.due) === e.due &&
        (g.durationMin ?? null) === (e.durationMin ?? null) &&
        JSON.stringify(rep(g.repeat)) === JSON.stringify(rep(e.repeat && { ...e.repeat, byday: e.repeat.byday })) &&
        (g.cat || '') === (e.cat || '');
      if (!same) failures.push(`${c.input}: got ${g.title} @ ${ls(g.due)}, expected ${e.title} @ ${e.due}`);
    });
  }
  assert.deepEqual(failures, []);
});

test('the phrases that used to be silently wrong', () => {
  const t = (s) => ls(parseLocal(s, NOW).due);
  assert.equal(t('Dentist fri 3pm'), '2026-10-09T15:00');
  assert.equal(t('Dentist Oct 20 at 3pm'), '2026-10-20T15:00');
  assert.equal(t('Stretch in 2 hours'), '2026-10-07T00:05');
  assert.equal(t('Lunch at noon'), '2026-10-07T12:00');
  assert.equal(t('Yearly check up tmrw at 10:30am'), '2026-10-07T10:30');
  assert.equal(parseLocal('Yearly check up tmrw at 10:30am', NOW).repeat, null);
});

test('description is split from the title', () => {
  const r = parseLocal('Dentist friday 9:30am. Bring insurance card', NOW);
  assert.equal(r.title, 'Dentist');
  assert.equal(r.description, 'Bring insurance card');
  const d = parseLocal('Dentist next Friday 3pm — bring insurance card', NOW);
  assert.equal(d.description, 'bring insurance card');
});

test('warnings: unknown date, assumed am/pm, past time, default time', () => {
  const warn = (s) => parseLocal(s, NOW).notes.map((n) => n.level + ':' + n.text);
  assert.ok(warn('Lab report').some((n) => n.startsWith('warn:No date')));
  assert.equal(parseLocal('Lab report', NOW).dateUnderstood, false);
  assert.ok(warn('Call dad at 3').some((n) => /am\/pm/.test(n)));
  assert.ok(warn('Call mom tonight').some((n) => /already passed/.test(n)));
  assert.ok(warn('Dentist friday').some((n) => n.startsWith('info:No time given')));
  assert.deepEqual(warn('Dentist friday 3pm'), []);
});

test('default time option', () => {
  assert.equal(ls(parseLocal('Dentist friday', NOW, { defaultTime: '08:15' }).due), '2026-10-09T08:15');
});

test('several tasks at once', () => {
  const r = parseAll('dentist fri 3pm, groceries sat, call mom tonight', NOW);
  assert.deepEqual(r.map((x) => x.title), ['Dentist', 'Groceries', 'Call mom']);
  assert.equal(parseAll('Buy milk, call mom tomorrow 5pm', NOW).length, 1);
  assert.equal(parseAll('a tomorrow 3pm\nb friday 4pm\n\nc', NOW).length, 3);
  assert.equal(parseAll(Array.from({ length: 30 }, (_, i) => `task ${i} friday`).join('\n'), NOW).length, 20);
});

test('never throws and always returns a usable task, even for junk', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const words = ['tomorrow', 'fri', 'every', 'monday', 'at', '3pm', '15:30', 'in', '2', 'hours', 'Oct', '20th', '#tag', 'for', 'an', 'hour', '-', '—', '.', ',', ';', '\n', 'noon', 'midnight', 'weekdays', 'next', 'week', 'the', '1st', '12/25', '2026-02-30', '99:99', 'p.m.', 'a.m.', 'Tom', 'night', 'every 0 days', 'Feb 31', '(', ')', '<b>', '𝒳', 'tonight', 'eod', 'monthly', 'on', 'the', '31st'];
  for (let i = 0; i < 4000; i++) {
    const n = 1 + Math.floor(rnd() * 9);
    const s = Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(rnd() < 0.5 ? ' ' : '');
    for (const t of parseAll(s, NOW)) {
      assert.ok(t.due instanceof Date && !isNaN(t.due), `bad due for ${JSON.stringify(s)}`);
      assert.ok(typeof t.title === 'string' && t.title.length > 0, `empty title for ${JSON.stringify(s)}`);
      assert.ok(t.repeat === null || isValidRepeat(t.repeat), `bad repeat for ${JSON.stringify(s)}`);
      assert.ok(t.durationMin === null || t.durationMin >= 5, `bad duration for ${JSON.stringify(s)}`);
    }
  }
  assert.equal(parseAll('', NOW).length, 0);
  assert.equal(parseAll('   \n  ', NOW).length, 0);
});

test('dates that do not exist are flagged, not rolled into the next month', () => {
  for (const s of ['Pay bill Feb 31', 'Report 2026-02-30', 'Trip 13/45']) {
    const r = parseLocal(s, NOW);
    assert.equal(r.dateUnderstood, false, s);
    assert.ok(r.notes.some((n) => /does not exist/.test(n.text)), s);
    assert.equal(ls(r.due), '2026-10-07T09:00', s);
  }
  assert.equal(ls(parseLocal('Leap day 2028-02-29 noon', NOW).due), '2028-02-29T12:00');
  assert.equal(ls(parseLocal('Close books the 31st', NOW).due), '2026-10-31T09:00');
});
