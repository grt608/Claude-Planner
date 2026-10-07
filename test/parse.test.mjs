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
    assert.ok(r.notes.some((n) => /not valid|does not exist/.test(n.text)), s);
    assert.equal(ls(r.due), '2026-10-07T09:00', s);
  }
  assert.equal(ls(parseLocal('Leap day 2028-02-29 noon', NOW).due), '2028-02-29T12:00');
  assert.equal(ls(parseLocal('Close books the 31st', NOW).due), '2026-10-31T09:00');
});

// ---- regressions from the independent review ----
const at = (s, now = NOW, o) => parseLocal(s, now, o);
const WED = new Date(2026, 9, 7, 10, 0); // Wed 2026-10-07 10:00
const FRI = new Date(2026, 9, 9, 10, 0); // Fri 2026-10-09 10:00

test('dotted and 24-hour dotted times', () => {
  for (const [s, due] of [['Call at 3.30pm', '2026-10-07T15:30'], ['Call 5.15 pm', '2026-10-07T17:15'], ['Call 10.30am tomorrow', '2026-10-08T10:30'], ['Call at 15.30', '2026-10-07T15:30'], ['Call at 3:30pm', '2026-10-07T15:30']]) {
    const r = at(s, WED);
    assert.equal(ls(r.due), due, s);
    assert.equal(r.title, 'Call', s);
  }
  assert.equal(at('Version 2.5 pm', WED).title.includes('2.5'), true);
});

test('a date-only task for today stays today (with a warning) instead of jumping a year', () => {
  for (const s of ['Gym oct 9', 'Gym 10/9', 'Gym 9 oct', 'Gym on the 9th']) {
    const r = at(s, FRI);
    assert.equal(ls(r.due), '2026-10-09T09:00', s);
    assert.ok(r.notes.some((n) => /already passed/.test(n.text)), s);
  }
  assert.equal(ls(at('Gym oct 8', FRI).due), '2027-10-08T09:00');
  assert.equal(ls(at('Gym oct 9 at 9am', FRI).due), '2027-10-09T09:00');
  assert.ok(at('Gym oct 8', FRI).notes.some((n) => /next year/.test(n.text)));
});

test('long titles are cut at a word and the rest is kept', () => {
  const long = 'Plan the whole entire semester of study material for the final exams in december including all of the chapters tomorrow';
  const r = at(long, WED);
  assert.ok(r.title.length <= 80 && !/\s$/.test(r.title));
  assert.ok(r.description.length > 0);
  assert.equal((r.title + ' ' + r.description).replace(/[. ]+/g, ' ').trim(), long.replace(' tomorrow', '').replace(/[. ]+/g, ' ').trim());
  const many = parseAll(Array.from({ length: 25 }, (_, i) => `task ${i} friday`).join('\n'), WED);
  assert.equal(many.length, 20);
  assert.ok(many[19].notes.some((n) => /Only the first 20/.test(n.text)));
  const huge = parseAll('dentist friday 3pm '.repeat(2000), WED);
  assert.ok(huge.at(-1).notes.some((n) => /5000 characters/.test(n.text)));
});

test('weekday lists and fuller repeat phrases', () => {
  const rp = (s) => at(s, WED).repeat;
  assert.deepEqual(rp('Class tuesdays and thursdays 2pm').byday, ['TU', 'TH']);
  assert.deepEqual(rp('Gym every tue thu').byday, ['TU', 'TH']);
  assert.deepEqual(rp('Gym every mon wed fri').byday, ['MO', 'WE', 'FR']);
  assert.deepEqual(rp('Trash every Monday Wednesday').byday, ['MO', 'WE']);
  assert.deepEqual(rp('Review every 2 weeks on monday and thursday'), { freq: 'WEEKLY', interval: 2, byday: ['MO', 'TH'] });
  assert.deepEqual(rp('Trash every other friday 6pm'), { freq: 'WEEKLY', interval: 2, byday: ['FR'] });
  assert.deepEqual(rp('Trash every weekend').byday, ['SA', 'SU']); // week order, Monday first
  assert.deepEqual(rp('Trash each monday 6pm'), { freq: 'WEEKLY', interval: 1, byday: ['MO'] });
  assert.deepEqual(rp('Review every two weeks on friday'), { freq: 'WEEKLY', interval: 2, byday: ['FR'] });
  assert.deepEqual(rp('Report biweekly friday'), { freq: 'WEEKLY', interval: 2, byday: ['FR'] });
  assert.equal(rp('Pills every 100 days at 8am').interval, 99);
  assert.ok(at('Pills every 100 days at 8am', WED).notes.some((n) => /99/.test(n.text)));
  // the first due date lies on the pattern
  assert.equal(at('Gym every tue thu', WED).due.getDay(), 4);
  // unknown repeat phrases warn instead of silently becoming one-off tasks
  for (const s of ['Trash every 2nd friday 6pm', 'Trash every last friday 6pm']) {
    const r = at(s, WED);
    assert.equal(r.repeat, null);
    assert.ok(r.notes.some((n) => /repeat/.test(n.text)), s);
  }
  // several weekdays without "every": one task, first day used, clear warning, no junk task
  const g = parseAll('Gym mon, wed and fri 6pm', WED);
  assert.equal(g.length, 1);
  assert.equal(g[0].title, 'Gym');
  assert.ok(g[0].notes.some((n) => /Several days/.test(n.text)));
});

test('compound "in ..." times', () => {
  const t = (s) => ls(at(s, WED).due);
  assert.equal(t('Call in 2 hours 30 minutes'), '2026-10-07T12:30');
  assert.equal(t('Call in 1 hour 30 min'), '2026-10-07T11:30');
  assert.equal(t('Call in an hour and a half'), '2026-10-07T11:30');
  assert.equal(t('Call in 1 day and 2 hours'), '2026-10-08T12:00');
  assert.equal(at('Call in 2 hours 30 minutes', WED).title, 'Call');
  const both = at('Call in 2 hours at 5pm', WED);
  assert.equal(ls(both.due), '2026-10-07T12:00');
  assert.ok(both.notes.some((n) => /only “in/.test(n.text)));
  assert.equal(at('Call tomorrow in 2 hours', WED).title, 'Call');
});

test('evening / night / tonight decide am vs pm', () => {
  const t = (s) => ls(at(s, WED).due);
  assert.equal(t('Dinner tomorrow evening at 7'), '2026-10-08T19:00');
  assert.equal(t('Dinner friday night at 8'), '2026-10-09T20:00');
  assert.equal(t('Call mom tonight at 8:30'), '2026-10-07T20:30');
  assert.equal(t('Call mom this evening at 7'), '2026-10-07T19:00');
  assert.equal(t('Call at 9 in the evening'), '2026-10-07T21:00');
  assert.equal(t('Call mom tomorrow afternoon at 2'), '2026-10-08T14:00');
  assert.equal(t('Run tomorrow morning at 6'), '2026-10-08T06:00');
  assert.deepEqual(at('Dinner tomorrow evening at 7', WED).notes, []);
});

test('absurd values never produce an invalid date', () => {
  for (const s of ['Call in 99999999999999 days', 'Call in 99999999999999999 minutes', 'Call in 99999999999 months', 'Report 9999-12-31', 'in ' + '9'.repeat(400) + ' hours']) {
    const r = at(s, WED);
    assert.ok(!isNaN(r.due), s);
    assert.equal(r.dateUnderstood, false, s);
    assert.ok(r.notes.some((n) => /not valid|out of range/.test(n.text)), s);
  }
});

test('fractions and ordinals do not hijack the date', () => {
  for (const [s, title, due] of [
    ['Buy 1/2 lb butter tomorrow', 'Buy 1/2 lb butter', '2026-10-08T09:00'],
    ['Bake with 3/4 cup flour friday', 'Bake with 3/4 cup flour', '2026-10-09T09:00'],
    ['Go to the 5th floor tomorrow', 'Go to the 5th floor', '2026-10-08T09:00'],
    ['Fix the 3rd step friday', 'Fix the 3rd step', '2026-10-09T09:00'],
    ['Report friday 10/9', 'Report', '2026-10-09T09:00'],
    ['Meeting 10/9 3pm', 'Meeting', '2026-10-09T15:00'],
  ]) {
    const r = at(s, WED);
    assert.equal(r.title, title, s);
    assert.equal(ls(r.due), due, s);
  }
  const clash = at('Dentist Tue 20/10 3pm', WED);
  assert.ok(clash.notes.some((n) => /Ignored/.test(n.text)));
  assert.equal(at('Buy 1/2 lb butter', WED).dateUnderstood, false);
});

test('dateGiven tells "no date typed" apart from "a time was typed"', () => {
  assert.equal(at('Dentist at 3pm', WED).dateGiven, false);
  assert.equal(at('Dentist friday', WED).dateGiven, true);
  assert.equal(at('Call in 2 hours', WED).dateGiven, true);
  assert.equal(at('Dentist at 3pm', WED).dateUnderstood, true);
});

test('timing: hostile inputs stay fast', () => {
  const cases = ['dentist friday 3pm '.repeat(5400), 'every '.repeat(20000), 'every ' + 'mon '.repeat(5000) + 'x', '1 '.repeat(20000), 'in ' + '1 hour and '.repeat(3000) + 'x', 'mondays and '.repeat(3000) + 'x', 'a friday, '.repeat(20000), '3 '.repeat(20000) + 'pm', 'at '.repeat(30000)];
  for (const c of cases) {
    const t = Date.now();
    parseAll(c, WED);
    assert.ok(Date.now() - t < 1500, `slow input: ${c.slice(0, 30)}`);
  }
});
