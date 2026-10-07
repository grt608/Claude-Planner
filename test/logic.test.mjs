import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLocal } from '../src/parse.js';
import { buildYear, countByDay } from '../src/year.js';
import { extractJson, fromLocalString } from '../src/ai.js';

const now = new Date(2026, 9, 6, 10, 0); // Tue Oct 6 2026 10:00

test('tomorrow + pm time', () => {
  const r = parseLocal('Call mom tomorrow at 3pm', now);
  assert.equal(r.title, 'Call mom');
  assert.deepEqual([r.due.getDate(), r.due.getHours()], [7, 15]);
});
test('weekday', () => {
  const r = parseLocal('Dentist friday 9:30am. Bring insurance card', now);
  assert.equal(r.due.getDay(), 5);
  assert.deepEqual([r.due.getHours(), r.due.getMinutes()], [9, 30]);
  assert.equal(r.description, 'Bring insurance card');
});
test('same weekday means next week', () => {
  assert.equal(parseLocal('gym tuesday 6pm', now).due.getDate(), 13);
});
test('iso date and M/D', () => {
  assert.equal(parseLocal('Tax filing 2027-04-15 at 5pm', now).due.getMonth(), 3);
  assert.equal(parseLocal('Party 3/5 at 7pm', now).due.getFullYear(), 2027);
});
test('time only that passed rolls to tomorrow', () => {
  assert.equal(parseLocal('stretch at 8am', now).due.getDate(), 7);
});
test('year grid', () => {
  const y = buildYear(now);
  assert.equal(y.length, 12);
  assert.equal(y[0].weeks.flat().filter(Boolean).length, 31);
  assert.ok(y.every((m) => m.weeks.every((w) => w.length === 7)));
  assert.equal(countByDay([{ due: now.toISOString() }, { due: now.toISOString() }, { due: now.toISOString(), done: true }])['2026-10-06'], 2);
});
test('ai json', () => {
  const o = extractJson('Sure! ```json\n{"title":"a","due":"2026-10-07T15:00"}\n```');
  assert.equal(fromLocalString(o.due).getHours(), 15);
});

import { buildICS, escapeText } from '../docs/ics.js';
const BS = String.fromCharCode(92);
test('ics escaping, folding and alarm', () => {
  assert.equal(escapeText('a;b,c' + BS + 'd\ne'), 'a' + BS + ';b' + BS + ',c' + BS + BS + 'd' + BS + 'ne');
  const s = buildICS([{ id: 'x', title: 'Dentist, 3pm; ÜÜ', description: 'é'.repeat(100), due: new Date(2026, 9, 9, 15, 0).toISOString() }], { now: new Date(Date.UTC(2026, 9, 6)) });
  assert.ok(s.includes('SUMMARY:Dentist' + BS + ', 3pm' + BS + '; ÜÜ\r\n'));
  assert.ok(s.includes('DTSTART:20261009T150000\r\n'));
  assert.ok(s.includes('TRIGGER:-PT30M\r\n'));
  assert.ok(s.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75));
  assert.equal(s.replace(/\r\n /g, '').match(/DESCRIPTION:é+/)[0].length, 'DESCRIPTION:'.length + 100);
});

import { createTaskFromText, DEFAULT_MODEL } from '../docs/ai.js';
test('ics uses uid override so rescheduled tasks import as new events', () => {
  const base = { id: 'a', title: 'T', description: '', due: new Date(2026, 9, 9, 15, 0).toISOString() };
  assert.ok(buildICS([base]).includes('UID:a@claude-planner'));
  assert.ok(buildICS([{ ...base, uid: 'b' }]).includes('UID:b@claude-planner'));
});
test('browser AI call: model, headers and fallback', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ content: [{ text: '{"title":"Dentist","description":"d","due":"2026-10-09T15:00"}' }] }) };
  };
  try {
    const now = new Date(2026, 9, 7, 9, 0);
    const r = await createTaskFromText('dentist friday 3pm', 'sk-test', now);
    assert.equal(r.source, 'ai');
    assert.equal(r.due.getHours(), 15);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, DEFAULT_MODEL);
    assert.equal(calls[0].init.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(calls[0].init.headers['x-api-key'], 'sk-test');
    await createTaskFromText('x', 'sk-test', now, 'custom-model');
    assert.equal(JSON.parse(calls[1].init.body).model, 'custom-model');
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    const f = await createTaskFromText('call mom tomorrow 3pm', 'sk-test', now);
    assert.equal(f.source, 'local');
    assert.match(f.aiError, /404/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
