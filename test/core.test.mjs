import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildICS, escapeText, trigger } from '../docs/ics.js';
import { describeRepeat, nextOccurrence, occurrences, repeatFromKey, repeatKey, rruleOf } from '../docs/recur.js';
import { buildYear, countByDay, dayKey, tasksOnDay } from '../docs/year.js';
import { createTasksFromText, createTaskFromText, DEFAULT_MODEL, extractJson, fromLocalString, normalizeAiTask } from '../docs/ai.js';

const BS = String.fromCharCode(92);
const NOW = new Date(2026, 9, 7, 9, 0);
const D = (y, m, d, h = 9, mi = 0) => new Date(y, m - 1, d, h, mi);
const ymd = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
const task = (due, repeat, extra = {}) => ({ id: 'x', title: 'T', due: due.toISOString(), repeat: repeat || null, ...extra });

test('year grid', () => {
  const y = buildYear(NOW);
  assert.equal(y.length, 12);
  assert.equal(y[0].weeks.flat().filter(Boolean).length, 31);
  assert.ok(y.every((m) => m.weeks.every((w) => w.length === 7)));
  assert.equal(countByDay([{ due: NOW.toISOString() }, { due: NOW.toISOString() }, { due: NOW.toISOString(), done: true }])['2026-10-07'], 2);
});

test('repeat rules expand correctly', () => {
  const mwf = task(D(2026, 10, 7, 6), { freq: 'WEEKLY', interval: 1, byday: ['MO', 'WE', 'FR'] });
  assert.deepEqual(occurrences(mwf, D(2026, 10, 1, 0), D(2026, 10, 20, 0)).map(ymd), ['2026-10-7 6:00', '2026-10-9 6:00', '2026-10-12 6:00', '2026-10-14 6:00', '2026-10-16 6:00', '2026-10-19 6:00']);
  assert.equal(ymd(nextOccurrence(mwf, D(2026, 10, 9, 6))), '2026-10-12 6:00');
  const biweekly = task(D(2026, 10, 7), { freq: 'WEEKLY', interval: 2, byday: ['WE'] });
  assert.deepEqual(occurrences(biweekly, D(2026, 10, 1, 0), D(2026, 11, 30, 0)).map(ymd), ['2026-10-7 9:00', '2026-10-21 9:00', '2026-11-4 9:00', '2026-11-18 9:00']);
  const m31 = task(D(2026, 1, 31), { freq: 'MONTHLY', interval: 1 });
  assert.deepEqual(occurrences(m31, D(2026, 1, 1, 0), D(2026, 6, 30, 0)).map(ymd), ['2026-1-31 9:00', '2026-3-31 9:00', '2026-5-31 9:00']); // short months are skipped
  const leap = task(D(2024, 2, 29), { freq: 'YEARLY', interval: 1 });
  assert.deepEqual(occurrences(leap, D(2024, 1, 1, 0), D(2029, 1, 1, 0)).map(ymd), ['2024-2-29 9:00', '2028-2-29 9:00']);
  const daily = task(D(2026, 3, 27, 9), { freq: 'DAILY', interval: 1 });
  assert.equal(occurrences(daily, D(2026, 3, 27, 0), D(2026, 4, 2, 23)).length, 7); // across the US daylight-saving change
  assert.ok(occurrences(daily, D(2026, 3, 27, 0), D(2026, 4, 2, 23)).every((d) => d.getHours() === 9));
  assert.equal(nextOccurrence(task(D(2026, 10, 7)), NOW), null);
  assert.deepEqual(occurrences(task(D(2026, 10, 7)), D(2026, 10, 1, 0), D(2026, 10, 30, 0)).map(ymd), ['2026-10-7 9:00']);
});

test('repeat helpers', () => {
  assert.equal(describeRepeat({ freq: 'WEEKLY', interval: 1, byday: ['MO', 'TU', 'WE', 'TH', 'FR'] }), 'Weekdays');
  assert.equal(describeRepeat({ freq: 'WEEKLY', interval: 2, byday: ['WE'] }), 'Every 2 weeks on Wed');
  assert.equal(describeRepeat({ freq: 'DAILY', interval: 3 }), 'Every 3 days');
  assert.equal(rruleOf({ freq: 'WEEKLY', interval: 2, byday: ['MO', 'WE'] }), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE');
  for (const k of ['daily', 'weekdays', 'weekly', 'monthly', 'yearly']) assert.equal(repeatKey(repeatFromKey(k, NOW)), k);
  assert.equal(repeatKey(null), 'none');
  assert.equal(repeatKey({ freq: 'DAILY', interval: 2 }), 'custom');
  assert.deepEqual(repeatFromKey('weekly', D(2026, 10, 7)).byday, ['WE']);
});

test('year view expands repeats and lists a day', () => {
  const mondays = task(D(2026, 10, 12, 18), { freq: 'WEEKLY', interval: 1, byday: ['MO'] });
  const counts = countByDay([mondays], D(2026, 10, 1, 0), D(2026, 10, 31, 23));
  assert.deepEqual(Object.keys(counts), ['2026-10-12', '2026-10-19', '2026-10-26']);
  assert.equal(tasksOnDay([mondays], '2026-10-19').length, 1);
  assert.equal(tasksOnDay([mondays], '2026-10-20').length, 0);
  assert.equal(tasksOnDay([task(D(2026, 10, 20))], '2026-10-20').length, 1);
  assert.equal(dayKey(D(2026, 1, 5)), '2026-01-05');
});

test('ics escaping, folding, alarms, duration and repeat', () => {
  assert.equal(escapeText('a;b,c' + BS + 'd\ne'), 'a' + BS + ';b' + BS + ',c' + BS + BS + 'd' + BS + 'ne');
  const stamp = { now: new Date(Date.UTC(2026, 9, 6)) };
  const s = buildICS([{ id: 'x', title: 'Dentist, 3pm; ÜÜ', description: 'é'.repeat(100), due: D(2026, 10, 9, 15).toISOString() }], stamp);
  assert.ok(s.includes('SUMMARY:Dentist' + BS + ', 3pm' + BS + '; ÜÜ\r\n'));
  assert.ok(s.includes('DTSTART:20261009T150000\r\n') && s.includes('DTEND:20261009T153000\r\n'));
  assert.ok(s.includes('TRIGGER:-PT30M\r\n'));
  assert.ok(s.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75));
  assert.equal(s.replace(/\r\n /g, '').match(/DESCRIPTION:é+/)[0].length, 'DESCRIPTION:'.length + 100);
  const r = buildICS([{ id: 'r', uid: 'u1', title: 'Gym', due: D(2026, 10, 12, 18).toISOString(), duration: 90, repeat: { freq: 'WEEKLY', interval: 1, byday: ['MO', 'WE'] } }], { alerts: [30, 1440, 30], ...stamp });
  assert.ok(r.includes('UID:u1@claude-planner\r\n'));
  assert.ok(r.includes('DTEND:20261012T193000\r\n'));
  assert.ok(r.includes('RRULE:FREQ=WEEKLY;BYDAY=MO,WE\r\n'));
  assert.equal(r.split('BEGIN:VALARM').length - 1, 2); // duplicate alert removed
  assert.ok(r.includes('TRIGGER:-PT30M\r\n') && r.includes('TRIGGER:-P1D\r\n'));
  assert.deepEqual([trigger(5), trigger(60), trigger(120), trigger(1440), trigger(2880), trigger(90)], ['-PT5M', '-PT1H', '-PT2H', '-P1D', '-P2D', '-PT90M']);
  assert.ok(buildICS([{ id: 'a', title: 'T', due: NOW.toISOString() }]).includes('UID:a@claude-planner'));
});

test('ai json helpers', () => {
  assert.equal(fromLocalString(extractJson('Sure! ```json\n{"title":"a","due":"2026-10-07T15:00"}\n```').due).getHours(), 15);
  assert.equal(fromLocalString('2026-13-45T99:99'), null);
});

test('ai: several tasks, repeats and validation', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  const reply = (obj) => async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ content: [{ text: JSON.stringify(obj) }] }) };
  };
  try {
    globalThis.fetch = reply({
      tasks: [
        { title: 'Dentist', description: 'd', due: '2026-10-09T15:00', durationMinutes: 60, repeat: null, category: '#Health', dateGuessed: false },
        { title: 'Gym', description: '', due: '2026-10-12T18:00', durationMinutes: null, repeat: { freq: 'weekly', interval: 1, byday: ['mo', 'we'] }, category: '' },
        { title: 'Bad repeat', description: '', due: '2026-10-12T18:00', repeat: { freq: 'HOURLY', interval: 1 } },
        { title: 'No date', description: '', due: 'tomorrow' },
        { description: 'no title', due: '2026-10-12T18:00' },
      ],
    });
    const list = await createTasksFromText('dentist and gym', 'sk-test', NOW);
    assert.equal(list.length, 3);
    assert.ok(list.every((t) => t.source === 'ai'));
    assert.equal(list[0].durationMin, 60);
    assert.equal(list[0].cat, 'health');
    assert.deepEqual(list[1].repeat, { freq: 'WEEKLY', interval: 1, byday: ['MO', 'WE'] });
    assert.equal(list[2].repeat, null);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, DEFAULT_MODEL);
    assert.equal(calls[0].init.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(calls[0].init.headers['x-api-key'], 'sk-test');
    await createTasksFromText('x', 'sk-test', NOW, 'custom-model');
    assert.equal(JSON.parse(calls[1].init.body).model, 'custom-model');

    globalThis.fetch = reply({ title: 'Single', description: '', due: '2026-10-09T15:00' }); // a bare object still works
    assert.equal((await createTaskFromText('x', 'sk-test', NOW)).title, 'Single');

    globalThis.fetch = async () => ({ ok: false, status: 404 });
    const f = await createTasksFromText('call mom tomorrow 3pm\nbuy milk friday', 'sk-test', NOW);
    assert.equal(f.length, 2);
    assert.ok(f.every((t) => t.source === 'local' && /404/.test(t.aiError)));
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.match((await createTaskFromText('x friday', 'sk-test', NOW)).aiError, /offline/);
    globalThis.fetch = reply({ tasks: [] });
    assert.equal((await createTasksFromText('x friday', 'sk-test', NOW))[0].source, 'local');
    assert.equal((await createTasksFromText('call mom tomorrow 3pm', '', NOW))[0].source, 'local');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(normalizeAiTask({ title: 't', due: '2026-10-01T10:00', durationMinutes: 2 }, NOW).notes.length, 1); // past time warns, tiny duration dropped
  assert.equal(normalizeAiTask({ title: 't', due: '2026-10-01T10:00', durationMinutes: 2 }, NOW).durationMin, null);
});

test('src copies stay identical to the web app modules, and the service worker caches every module', () => {
  for (const f of ['ai.js', 'parse.js', 'recur.js', 'year.js']) {
    assert.equal(fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'), fs.readFileSync(new URL(`../docs/${f}`, import.meta.url), 'utf8'), `run "npm run sync" (${f} differs)`);
  }
  const sw = fs.readFileSync(new URL('../docs/sw.js', import.meta.url), 'utf8');
  for (const f of fs.readdirSync(new URL('../docs/', import.meta.url)).filter((x) => /\.(js|html|webmanifest|png)$/.test(x) && x !== 'sw.js')) {
    if (f === 'index.html') continue;
    assert.ok(sw.includes(`'${f}'`), `${f} missing from the service worker shell`);
  }
});

test('local date strings reject impossible values', () => {
  for (const s of ['2026-02-30T10:00', '2026-13-01T10:00', '2026-10-07T24:00', '2026-10-07T10:60', 'nope', '']) assert.equal(fromLocalString(s), null, s);
  assert.equal(fromLocalString('2028-02-29T23:59').getDate(), 29);
});
