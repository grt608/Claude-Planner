import { parseLocal } from './parse.js';

// Haiku 4.5 is listed as retiring no sooner than 2026-10-15, so default to Sonnet 5.5 and let the user override it.
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

const pad = (n) => String(n).padStart(2, '0');
export const toLocalString = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

// "2026-03-05T15:30" (local wall-clock time, no zone) -> Date
export function fromLocalString(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s || '');
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

export function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON in AI response');
  return JSON.parse(m[0]);
}

/**
 * Turn free text ("dentist next friday 3pm, bring insurance card") into
 * { title, description, due: Date, source: 'ai' | 'local' }.
 */
export async function createTaskFromText(text, apiKey, now = new Date(), model = DEFAULT_MODEL) {
  if (apiKey) {
    try {
      const task = await askClaude(text, apiKey, now, model || DEFAULT_MODEL);
      return { ...task, source: 'ai' };
    } catch (e) {
      const fallback = parseLocal(text, now);
      return { ...fallback, source: 'local', aiError: String(e.message || e) };
    }
  }
  return { ...parseLocal(text, now), source: 'local' };
}

async function askClaude(text, apiKey, now, model) {
  const system = [
    'You turn a person\'s casual note into a planner task.',
    `Current local date/time: ${toLocalString(now)} (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getDay()]}).`,
    'Reply with ONLY a JSON object: {"title": string, "description": string, "due": "YYYY-MM-DDTHH:mm"}.',
    '- title: short and action-oriented (max 60 chars).',
    '- description: one brief sentence with any useful details from the note; if the note has none, a short helpful hint.',
    '- due: the local wall-clock time the person wants to do the task. Resolve relative dates ("next friday", "in 2 hours") against the current time. If no time is given choose a sensible one (default 09:00). The due time must be in the future.',
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
      max_tokens: 300,
      system,
      messages: [{ role: 'user', content: text }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json();
  const out = extractJson(data.content?.map((b) => b.text || '').join('') || '');
  const due = fromLocalString(out.due);
  if (!out.title || !due) throw new Error('Incomplete AI response');
  return { title: String(out.title), description: String(out.description || ''), due };
}
