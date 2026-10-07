import { parseLocal, parseAll, fitTitle, isPlausible, MAX_DURATION_MIN, MAX_TASKS_PER_MESSAGE } from './parse.js';
import { cleanRepeat } from './recur.js';

// Haiku 4.5 is listed as retiring no sooner than 2026-10-15, so default to Sonnet 5.5 and let the user override it.
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

const pad = (n) => String(n).padStart(2, '0');
export const toLocalString = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

// "2026-03-05T15:30" (local wall-clock time, no zone) -> Date
export function fromLocalString(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // reject impossible values (month 13, Feb 30, 25:00) instead of letting them roll over
  return isPlausible(d) && d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] && d.getHours() === +m[4] && d.getMinutes() === +m[5] ? d : null;
}

export function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON in AI response');
  return JSON.parse(m[0]);
}

/** Validate one task object from the model into the app's task shape (or null). */
export function normalizeAiTask(o, now = new Date()) {
  if (!o || typeof o !== 'object' || !o.title) return null;
  const due = fromLocalString(o.due);
  if (!due) return null;
  const dur = Number(o.durationMinutes);
  const repeat = cleanRepeat(o.repeat);
  const notes = [];
  if (o.dateGuessed) notes.push({ level: 'warn', text: 'No date was given, so one was guessed. Check the date.' });
  if (due < now) notes.push({ level: 'warn', text: 'That time has already passed.' });
  const fitted = fitTitle(String(o.title), String(o.description || ''));
  return {
    title: fitted.title,
    description: fitted.description,
    due,
    durationMin: Number.isFinite(dur) && dur >= 5 && dur <= MAX_DURATION_MIN ? Math.round(dur) : null,
    repeat,
    cat: String(o.category || '').toLowerCase().replace(/^#/, '').slice(0, 24),
    dateUnderstood: !o.dateGuessed,
    dateGiven: !o.dateGuessed,
    timeUnderstood: true,
    foundWhen: true,
    notes,
  };
}

/**
 * Turn free text into one or more tasks: [{ title, description, due: Date, durationMin, repeat, cat, notes,
 * source: 'ai' | 'local', aiError? }]. With an API key Claude does the parsing; on any failure (or without a
 * key) the offline parser is used.
 */
export async function createTasksFromText(text, apiKey, now = new Date(), model = DEFAULT_MODEL, opts = {}) {
  if (apiKey) {
    try {
      return (await askClaude(text, apiKey, now, model || DEFAULT_MODEL, opts)).map((t) => ({ ...t, source: 'ai' }));
    } catch (e) {
      const aiError = String((e && e.message) || e);
      return parseAll(text, now, opts).map((t) => ({ ...t, source: 'local', aiError }));
    }
  }
  return parseAll(text, now, opts).map((t) => ({ ...t, source: 'local' }));
}

/** Single-task variant (kept for the Expo app). */
export async function createTaskFromText(text, apiKey, now = new Date(), model = DEFAULT_MODEL, opts = {}) {
  if (apiKey) {
    try {
      const [first] = await askClaude(text, apiKey, now, model || DEFAULT_MODEL, opts);
      return { ...first, source: 'ai' };
    } catch (e) {
      return { ...parseLocal(text, now, opts), source: 'local', aiError: String((e && e.message) || e) };
    }
  }
  return { ...parseLocal(text, now, opts), source: 'local' };
}

async function askClaude(text, apiKey, now, model, opts) {
  const def = opts.defaultTime || '09:00';
  const system = [
    "You turn a person's casual note into planner tasks. The note may describe one task or several.",
    `Current local date/time: ${toLocalString(now)} (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getDay()]}).`,
    'Reply with ONLY a JSON object: {"tasks":[{"title": string, "description": string, "due": "YYYY-MM-DDTHH:mm", "durationMinutes": number|null, "repeat": null|{"freq":"DAILY|WEEKLY|MONTHLY|YEARLY","interval":number,"byday":["MO","TU","WE","TH","FR","SA","SU"]}, "category": string, "dateGuessed": boolean}]}.',
    '- title: short and action-oriented (max 60 chars). Do not include the date or time in the title.',
    '- description: one brief sentence with details from the note (empty string if none).',
    `- due: the local wall-clock time the person wants to start. Resolve relative dates ("next friday", "in 2 hours") against the current time. If a date is given without a time use ${def}. If no date at all is given, pick tomorrow and set dateGuessed true. The first due must be in the future.`,
    '- durationMinutes: only if the note states a length or a time range (e.g. "2-3pm" = 60), otherwise null.',
    '- repeat: only if the note clearly repeats ("every monday", "daily"); due is then the first occurrence. byday is only for WEEKLY. Otherwise null.',
    '- category: a one-word lowercase tag only if the note has a #hashtag or an obvious category (work, health, school, home), otherwise "".',
  ].join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      system,
      messages: [{ role: 'user', content: text }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json();
  const out = extractJson(data.content?.map((b) => b.text || '').join('') || '');
  const all = (Array.isArray(out.tasks) ? out.tasks : [out]).map((o) => normalizeAiTask(o, now)).filter(Boolean);
  if (!all.length) throw new Error('Incomplete AI response');
  const list = all.slice(0, MAX_TASKS_PER_MESSAGE);
  if (all.length > list.length) list[list.length - 1].notes.push({ level: 'warn', text: `Only the first ${MAX_TASKS_PER_MESSAGE} tasks were added; ${all.length - list.length} more were left out. Send them again.` });
  return list;
}
