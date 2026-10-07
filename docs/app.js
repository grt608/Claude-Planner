import { createTasksFromText, toLocalString, fromLocalString, DEFAULT_MODEL } from './ai.js';
import { buildICS } from './ics.js';
import { buildYear, countByDay, dayKey, tasksOnDay } from './year.js';
import { describeRepeat, isValidRepeat, nextOccurrence, repeatFromKey, repeatKey } from './recur.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DEFAULTS = { lead: 30, alert2: 0, defaultTime: '09:00', lastBackup: null, nagUntil: null };
const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

function normalizeTask(t) {
  if (!t || !t.id || !t.title || isNaN(new Date(t.due))) return null;
  return {
    id: String(t.id),
    uid: t.uid ? String(t.uid) : undefined,
    title: String(t.title).slice(0, 200),
    description: String(t.description || ''),
    due: new Date(t.due).toISOString(),
    done: !!t.done,
    reminded: !!t.reminded,
    duration: t.duration > 0 ? Math.round(t.duration) : undefined,
    repeat: isValidRepeat(t.repeat) ? t.repeat : null,
    cat: String(t.cat || '').toLowerCase().slice(0, 24),
  };
}

const state = {
  tasks: store.get('planner.tasks.v1', []).map(normalizeTask).filter(Boolean),
  key: store.get('planner.apiKey', ''),
  model: store.get('planner.model', ''),
  settings: { ...DEFAULTS, ...store.get('planner.settings.v1', {}) },
  tab: 'tasks',
  sel: dayKey(new Date()),
  busy: false,
  note: '',
  draft: '',
  forDate: null, // "YYYY-MM-DD": tasks typed without a date go on this day
  recent: [], // [{ id, notes }] shown after adding several tasks at once
  q: '',
  cat: '',
  showDone: false,
  hideInstall: store.get('planner.hideInstall', false),
};

const $ = (s) => document.querySelector(s);
const view = $('#view');
const dlg = $('#edit');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (iso) =>
  new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtDay = (key) => new Date(key + 'T00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const byDue = (a, b) => new Date(a.due) - new Date(b.due);
const save = () => store.set('planner.tasks.v1', state.tasks);
const saveSettings = () => store.set('planner.settings.v1', state.settings);
const alerts = () => [state.settings.lead, state.settings.alert2].filter((n) => n > 0);
const minLabel = (n) => (n % 1440 === 0 ? `${n / 1440} day${n === 1440 ? '' : 's'}` : n % 60 === 0 ? `${n / 60} hour${n === 60 ? '' : 's'}` : `${n} min`);
const durLabel = (n) => (n % 60 === 0 ? `${n / 60} h` : n > 60 ? `${Math.floor(n / 60)} h ${n % 60} min` : `${n} min`);
const find = (id) => state.tasks.find((t) => t.id === id);

let toastTimer;
function toast(msg, ms = 4000, action) {
  const t = $('#toast');
  t.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.className = 'toast-btn';
    b.onclick = () => {
      t.hidden = true;
      action.fn();
    };
    t.append(' ', b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---- delivering a file to the iPhone (calendar import / backup) ----
// Research notes: in a normal Safari tab a typed-Blob download link is the route most likely to open the
// "Add to Calendar" sheet; in an installed home-screen app downloads can open a preview with no way back,
// so only the share sheet is tried there. Never navigate to a data: URL.
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const ICS_MIME = 'text/calendar;charset=utf-8';

function downloadFile(filename, mime, text) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Must be called straight from a tap handler (iOS requires a user gesture for the share sheet).
async function shareFile(filename, mime, text) {
  const file = new File([text], filename, { type: mime.split(';')[0] });
  if (!(navigator.canShare && navigator.canShare({ files: [file] }))) return 'unavailable';
  try {
    await navigator.share({ files: [file], title: filename });
    return 'shared';
  } catch (e) {
    return e && e.name === 'AbortError' ? 'cancelled' : 'unavailable';
  }
}

async function deliver(filename, mime, text) {
  if (!isStandalone()) {
    downloadFile(filename, mime, text);
    return 'downloaded';
  }
  return shareFile(filename, mime, text);
}

async function sendToCalendar(tasks) {
  const list = tasks.filter((t) => t.repeat || (!t.done && new Date(t.due) > new Date()));
  const skipped = tasks.filter((t) => !t.done).length - list.length;
  const skip = skipped > 0 ? ` ${skipped} task${skipped > 1 ? 's' : ''} skipped because the time has already passed.` : '';
  if (!list.length) return toast('Nothing upcoming to add.' + skip);
  const r = await deliver(list.length === 1 ? 'task.ics' : 'planner-tasks.ics', ICS_MIME, buildICS(list, { alerts: alerts() }));
  if (r === 'cancelled') return;
  if (r === 'unavailable') return toast('The share sheet did not open. Open this page in Safari (not the home-screen icon) and try again.', 8000);
  list.forEach((t) => (t.reminded = true));
  save();
  render();
  if (r === 'shared') toast('Choose Calendar in the share sheet to finish.' + skip, 7000);
  if (r === 'downloaded') toast('If no “Add to Calendar” sheet appeared, tap the download arrow in Safari’s address bar and open the file. See Settings → Calendar methods.' + skip, 9000);
}

// ---- task changes ----
function reschedule(t, due) {
  t.due = due.toISOString();
  t.reminded = false;
  t.uid = newId(); // Calendar ignores an updated event that reuses a UID, so a moved task gets a new one
}

function completeTask(t) {
  if (t.repeat && !t.done) {
    const next = nextOccurrence(t, new Date(Math.max(Date.now(), new Date(t.due).getTime())));
    if (next) {
      t.due = next.toISOString(); // the Calendar series keeps going on its own; only this list moves on
      save();
      render();
      return toast(`Done. Next: ${fmt(t.due)}`);
    }
  }
  t.done = !t.done;
  save();
  render();
}

function removeTask(id) {
  const index = state.tasks.findIndex((t) => t.id === id);
  if (index < 0) return;
  const [task] = state.tasks.splice(index, 1);
  save();
  render();
  toast(`Deleted “${task.title}”.`, 8000, {
    label: 'Undo',
    fn: () => {
      state.tasks.splice(Math.min(index, state.tasks.length), 0, task);
      save();
      render();
    },
  });
}

async function addTasks(text) {
  if (!text.trim() || state.busy) return;
  state.busy = true;
  state.recent = [];
  render();
  const results = await createTasksFromText(text, state.key, new Date(), state.model || DEFAULT_MODEL, { defaultTime: state.settings.defaultTime });
  const created = [];
  for (const r of results) {
    let due = r.due;
    let notes = r.notes.slice();
    if (state.forDate && !r.dateUnderstood) {
      const [y, m, d] = state.forDate.split('-').map(Number);
      due = new Date(y, m - 1, d, due.getHours(), due.getMinutes());
      notes = notes.filter((n) => !/No date/.test(n.text));
      notes.push({ level: 'info', text: `Set for ${fmtDay(state.forDate)}.` });
    }
    const t = {
      id: newId(),
      title: r.title,
      description: r.description || '',
      due: due.toISOString(),
      done: false,
      reminded: false,
      duration: r.durationMin || undefined,
      repeat: r.repeat || null,
      cat: r.cat || '',
    };
    state.tasks.push(t);
    created.push({ id: t.id, notes });
  }
  save();
  const first = results[0];
  state.note = first && first.source === 'local' ? (state.key ? `AI unavailable (${first.aiError || 'error'}), used built-in parsing.` : 'Built-in parsing used. Add an API key in Settings for AI.') : '';
  state.busy = false;
  state.draft = '';
  state.forDate = null;
  if (created.length === 1) {
    render();
    openEdit(created[0].id, { fresh: true, notes: created[0].notes });
  } else {
    state.recent = created;
    render();
  }
}

// ---- edit dialog ----
const options = (list, value, label) => list.map((v) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(label(v))}</option>`).join('');

function openEdit(id, { fresh = false, notes = [] } = {}) {
  const t = find(id);
  if (!t) return;
  const dur = t.duration || 30;
  const durs = DURATIONS.includes(dur) ? DURATIONS : [...DURATIONS, dur].sort((a, b) => a - b);
  const rk = repeatKey(t.repeat);
  const cats = [...new Set(state.tasks.map((x) => x.cat).filter(Boolean))];
  const repNote = t.repeat ? `<p class="note">Repeats: ${esc(describeRepeat(t.repeat))}. The Calendar event will repeat too.</p>` : '';
  dlg.innerHTML = `
    <h2 style="margin:0 0 4px">${fresh ? 'Task created' : 'Edit task'}</h2>
    ${notes.map((n) => `<p class="msg ${n.level}">${esc(n.text)}</p>`).join('')}
    ${fresh ? '<p class="note" style="margin-top:0">Check the details, then add the reminder to your Calendar.</p>' : ''}
    <label>Title</label><input id="e-title" value="${esc(t.title)}">
    <label>Details</label><textarea id="e-desc">${esc(t.description)}</textarea>
    <label>When</label><input id="e-due" type="datetime-local" value="${toLocalString(new Date(t.due))}">
    <div class="two">
      <div><label>Length</label><select id="e-dur">${options(durs, dur, durLabel)}</select></div>
      <div><label>Repeat</label><select id="e-rep">
        ${options(['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly', ...(rk === 'custom' ? ['custom'] : [])], rk, (k) => ({ none: 'Does not repeat', daily: 'Every day', weekdays: 'Weekdays', weekly: 'Every week', monthly: 'Every month', yearly: 'Every year', custom: describeRepeat(t.repeat) })[k])}
      </select></div>
    </div>
    <label>Category</label><input id="e-cat" list="cats" autocapitalize="off" placeholder="e.g. school" value="${esc(t.cat)}"><datalist id="cats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    ${repNote}
    <button data-a="e-cal" data-id="${t.id}">🔔 Save &amp; add reminder to Calendar</button>
    <button class="sec" data-a="e-save" data-id="${t.id}">Save</button>
    <label>Move it</label>
    <div class="three">
      <button class="sec" data-a="e-snooze" data-k="hour" data-id="${t.id}">+1 hour</button>
      <button class="sec" data-a="e-snooze" data-k="day" data-id="${t.id}">Tomorrow</button>
      <button class="sec" data-a="e-snooze" data-k="week" data-id="${t.id}">Next week</button>
    </div>
    <button class="sec" data-a="e-done" data-id="${t.id}">${t.done ? 'Mark not done' : t.repeat ? 'Done — go to next time' : 'Mark done'}</button>
    <button class="bad" data-a="e-del" data-id="${t.id}">Delete</button>
    ${t.reminded ? '<p class="note">A reminder for the old time may already be in Calendar — if you change the time, length or repeat, delete the old event there.</p>' : ''}`;
  dlg.showModal();
}

function readEdit(id) {
  const t = find(id);
  const due = fromLocalString($('#e-due').value) || new Date(t.due);
  const dur = Number($('#e-dur').value) || 30;
  const key = $('#e-rep').value;
  const before = JSON.stringify([t.due, t.duration || 30, t.repeat]);
  t.title = $('#e-title').value.trim() || t.title;
  t.description = $('#e-desc').value.trim();
  t.cat = $('#e-cat').value.trim().toLowerCase().replace(/^#/, '').slice(0, 24);
  t.duration = dur === 30 ? undefined : dur;
  t.due = due.toISOString();
  if (key !== 'custom') t.repeat = repeatFromKey(key, due);
  if (JSON.stringify([t.due, t.duration || 30, t.repeat]) !== before) {
    t.reminded = false;
    t.uid = newId();
  }
  save();
  return t;
}

dlg.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-a]');
  if (!b) return;
  const id = b.dataset.id;
  const a = b.dataset.a;
  if (a === 'e-save') {
    readEdit(id);
    dlg.close();
  } else if (a === 'e-cal') {
    const t = readEdit(id);
    dlg.close();
    sendToCalendar([t]);
  } else if (a === 'e-snooze') {
    const t = readEdit(id);
    const due = new Date(t.due);
    const base = Math.max(due.getTime(), Date.now());
    let next;
    if (b.dataset.k === 'hour') {
      next = new Date(base + 3600000);
      next.setMinutes(Math.ceil(next.getMinutes() / 5) * 5, 0, 0);
    } else {
      const day = new Date(base);
      day.setDate(day.getDate() + (b.dataset.k === 'day' ? 1 : 7));
      next = new Date(day.getFullYear(), day.getMonth(), day.getDate(), due.getHours(), due.getMinutes());
    }
    reschedule(t, next);
    if (t.repeat && t.repeat.byday && t.repeat.byday.length === 1) t.repeat = repeatFromKey('weekly', next);
    save();
    dlg.close();
    toast(`Moved to ${fmt(t.due)}. Add a new reminder to Calendar if you need one.`, 6000);
  } else if (a === 'e-done') {
    readEdit(id);
    dlg.close();
    completeTask(find(id));
  } else if (a === 'e-del') {
    dlg.close();
    removeTask(id);
  }
});

// ---- views ----
function rowHtml(t, { at, check = true } = {}) {
  const when = at ? at.toISOString() : t.due;
  const chips = [
    t.repeat ? `<span class="chip">🔁 ${esc(describeRepeat(t.repeat))}</span>` : '',
    t.cat ? `<span class="chip">#${esc(t.cat)}</span>` : '',
    t.duration ? `<span class="chip">${esc(durLabel(t.duration))}</span>` : '',
  ].join('');
  return `<div class="row">
    ${check ? `<button class="chk ${t.done ? 'on' : ''}" data-a="toggle" data-id="${t.id}" aria-label="${t.done ? 'Mark not done' : 'Mark done'}"></button>` : '<span class="chk-gap"></span>'}
    <div class="t" data-a="open" data-id="${t.id}" role="button" tabindex="0">
      <div class="name ${t.done ? 'done' : ''}">${esc(t.title)}</div>
      ${t.description ? `<div class="desc">${esc(t.description)}</div>` : ''}
      <div class="when">${esc(fmt(when))}${t.reminded ? ' · 🔔' : ''}</div>
      ${chips ? `<div class="chips">${chips}</div>` : ''}
    </div></div>`;
}

function installHint() {
  if (isStandalone() || state.hideInstall) return '';
  return `<div class="card"><b>Install it</b><div class="note">In Safari tap the Share button, then <b>Add to Home Screen</b> (leave <b>Open as Web App</b> on). Then open it from the icon and add your key and tasks there — the icon and Safari do not share data.</div>
    <button class="sec" data-a="hide-install">Got it</button></div>`;
}

function backupNag() {
  const s = state.settings;
  const days = s.lastBackup ? (Date.now() - new Date(s.lastBackup)) / 86400000 : Infinity;
  if (state.tasks.length < 5 || days < 14 || (s.nagUntil && Date.now() < new Date(s.nagUntil))) return '';
  return `<div class="card"><b>Back up your tasks</b><div class="note">${s.lastBackup ? `Last backup ${Math.floor(days)} days ago.` : 'You have not saved a backup yet.'} Tasks live only on this phone.</div>
    <button class="sec" data-a="export">Export backup</button><button class="sec" data-a="nag-later">Remind me next week</button></div>`;
}

function tasksView() {
  const now = Date.now();
  const q = state.q.trim().toLowerCase();
  const all = state.tasks;
  const cats = [...new Set(all.map((t) => t.cat).filter(Boolean))].sort();
  const match = (t) => (!q || (t.title + ' ' + t.description + ' ' + t.cat).toLowerCase().includes(q)) && (!state.cat || t.cat === state.cat);
  const list = all.filter(match).sort(byDue);
  const open = list.filter((t) => !t.done);
  const today = dayKey(new Date());
  const overdue = open.filter((t) => new Date(t.due) < now && dayKey(new Date(t.due)) !== today);
  const todays = open.filter((t) => dayKey(new Date(t.due)) === today);
  const later = open.filter((t) => dayKey(new Date(t.due)) > today);
  const done = list.filter((t) => t.done).sort((a, b) => byDue(b, a));
  const soon = all.filter((t) => !t.done && new Date(t.due) - now <= state.settings.lead * 60000 && new Date(t.due) - now > -3600000).sort(byDue);
  const pending = all.filter((t) => !t.reminded && !t.done && (t.repeat || new Date(t.due) > now));
  const section = (title, items, cls = '') => (items.length ? `<div class="sec-h ${cls}">${title} <span class="mute">${items.length}</span></div><div class="card">${items.map((t) => rowHtml(t)).join('')}</div>` : '');
  const recent = state.recent
    .map((r) => ({ t: find(r.id), notes: r.notes }))
    .filter((r) => r.t);

  return `<h1>Planner</h1>
    ${installHint()}
    ${soon.length ? `<div class="card soon"><b>⏰ Starting soon</b>${soon.map((t) => `<div>${esc(t.title)} — ${esc(fmt(t.due))}</div>`).join('')}</div>` : ''}
    <div class="card">
      ${state.forDate ? `<p class="msg info">Adding for <b>${esc(fmtDay(state.forDate))}</b>. Tasks without a date go there. <a href="#" data-a="clear-for">Clear</a></p>` : ''}
      <textarea id="draft" enterkeyhint="done" placeholder="e.g. Dentist next Friday 3pm — bring insurance card">${esc(state.draft)}</textarea>
      <p class="hint">Tip: several tasks at once (one per line or comma-separated), “every Monday 6pm”, “2-3pm”, #school. Tap the keyboard’s mic to dictate.</p>
      <button data-a="add" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Working…' : '✨ Create task'}</button>
      ${state.note ? `<p class="note">${esc(state.note)}</p>` : ''}
    </div>
    ${
      recent.length
        ? `<div class="card"><b>Just added ${recent.length} tasks</b>
        ${recent.map((r) => rowHtml(r.t) + r.notes.map((n) => `<p class="msg ${n.level}">${esc(r.t.title)}: ${esc(n.text)}</p>`).join('')).join('')}
        <button data-a="cal-recent">🔔 Add these ${recent.length} to Calendar</button><button class="sec" data-a="dismiss-recent">Dismiss</button></div>`
        : ''
    }
    ${backupNag()}
    ${pending.length ? `<button class="sec" data-a="cal-all" style="margin:0 0 14px">🔔 Add ${pending.length} task${pending.length > 1 ? 's' : ''} without a reminder to Calendar</button>` : ''}
    ${
      all.length >= 6 || q || state.cat
        ? `<div class="card filter"><input id="q" type="search" placeholder="Search tasks" value="${esc(state.q)}" autocomplete="off">
        ${cats.length ? `<div class="cats"><button class="pill ${state.cat ? '' : 'on'}" data-a="cat" data-c="">All</button>${cats.map((c) => `<button class="pill ${state.cat === c ? 'on' : ''}" data-a="cat" data-c="${esc(c)}">#${esc(c)}</button>`).join('')}</div>` : ''}</div>`
        : ''
    }
    ${section('Overdue', overdue, 'bad-h')}
    ${section('Today', todays)}
    ${section('Upcoming', later)}
    ${!open.length ? `<div class="card"><p class="mute" style="text-align:center">${all.length ? 'Nothing here.' : 'No tasks yet. Describe one above.'}</p></div>` : ''}
    ${
      done.length
        ? `<div class="sec-h"><a href="#" data-a="toggle-done">${state.showDone ? '▾' : '▸'} Done <span class="mute">${done.length}</span></a>${state.showDone ? ' <a href="#" data-a="clear-done" class="bad-link">Clear done</a>' : ''}</div>${state.showDone ? `<div class="card">${done.map((t) => rowHtml(t)).join('')}</div>` : ''}`
        : ''
    }`;
}

function yearView() {
  const today = new Date();
  const months = buildYear(today);
  const from = new Date(today.getFullYear(), today.getMonth(), 1);
  const to = new Date(today.getFullYear(), today.getMonth() + 12, 0, 23, 59, 59);
  const counts = countByDay(state.tasks, from, to);
  const todayKey = dayKey(today);
  const upcoming = state.tasks.filter((t) => !t.done && (t.repeat || new Date(t.due) >= from)).length;
  const day = tasksOnDay(state.tasks, state.sel);
  return `<h1>Next 12 months</h1>
    <p class="mute" style="margin-top:0">${upcoming} upcoming task${upcoming === 1 ? '' : 's'} · repeats count each time · tap a day</p>
    <div class="card"><div class="when" style="font-weight:600;color:var(--brand)">${esc(new Date(state.sel + 'T00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }))}</div>
      ${day.length ? day.map(({ task, at }) => rowHtml(task, { at, check: !task.repeat || +at === +new Date(task.due) })).join('') : '<p class="mute">Nothing planned.</p>'}
      <button class="sec" data-a="add-day">＋ Add a task on this day</button></div>
    ${months
      .map(
        ({ first, weeks }) => `<div class="card month" id="m-${first.getFullYear()}-${first.getMonth()}"><h3>${MONTHS[first.getMonth()]} ${first.getFullYear()}</h3>
      <div class="grid">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<div class="dow">${d}</div>`).join('')}
      ${weeks
        .flat()
        .map((d) => {
          if (!d) return '<div class="day blank"></div>';
          const k = dayKey(d);
          const n = Math.min(counts[k] || 0, 4);
          return `<button class="day h${n} ${k === todayKey ? 'today' : ''} ${k === state.sel ? 'sel' : ''}" data-a="day" data-k="${k}" aria-label="${esc(fmtDay(k))}, ${counts[k] || 0} tasks">${d.getDate()}</button>`;
        })
        .join('')}</div></div>`,
      )
      .join('')}
    <div class="legend"><span class="mute">Fewer</span>${[0, 1, 2, 3, 4].map((i) => `<i style="background:var(--h${i})"></i>`).join('')}<span class="mute">More</span></div>`;
}

function settingsView() {
  const s = state.settings;
  return `<h1>Settings</h1>
    <div class="card"><b>Reminders</b>
      <p class="note">iPhone web apps can't schedule their own alerts, so each task is sent to the Calendar app with these alerts. Calendar then notifies you even when this app is closed.</p>
      <label>First alert</label><select data-set="lead">${options([5, 10, 15, 30, 60, 120], s.lead, (n) => `${minLabel(n)} before`)}</select>
      <label>Second alert (optional)</label><select data-set="alert2">${options([0, 60, 1440, 2880], s.alert2, (n) => (n ? `${minLabel(n)} before` : 'None'))}</select>
      <label>Time used when you don't say one</label><input data-set="defaultTime" type="time" value="${esc(s.defaultTime)}">
    </div>
    <div class="card"><b>Anthropic API key (optional)</b>
      <p class="note">Lets Claude read your notes and fill in the title, details, time, length and repeats. Without it the app uses built-in parsing. The key stays on this phone and is sent only to api.anthropic.com. Anyone who can unlock this phone and open the app could read it.</p>
      <input id="key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(state.key)}">
      <label>Model</label>
      <input id="model" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc(DEFAULT_MODEL)}" value="${esc(state.model)}">
      <p class="note">Leave blank for ${esc(DEFAULT_MODEL)}. If AI stops working, a model may have been retired — try another current model name.</p>
      <button data-a="save-key">Save</button></div>
    <div class="card"><b>Calendar methods</b>
      <p class="note">If a task's “add to Calendar” button doesn't bring up Calendar's Add screen, try each of these. Each sends a test event 40 minutes from now with your first alert.</p>
      <button class="sec" data-a="test-dl">1. Download link (use in Safari)</button>
      <button class="sec" data-a="test-open">2. Open file in this tab (use in Safari)</button>
      <button class="sec" data-a="test-share">3. Share sheet</button></div>
    <div class="card"><b>Backup</b>
      <p class="note">Tasks live in this app's storage on your phone. ${s.lastBackup ? `Last backup: ${esc(new Date(s.lastBackup).toLocaleDateString())}.` : 'No backup yet.'}</p>
      <button class="sec" data-a="export">Export backup</button>
      <button class="sec" data-a="import">Import backup</button>
      <button class="sec" data-a="export-ics">Export all upcoming as a calendar file</button>
      <input id="file" type="file" accept=".json,application/json" hidden></div>`;
}

function render() {
  if (dlg.open) return;
  const y = scrollY;
  view.innerHTML = { tasks: tasksView, year: yearView, settings: settingsView }[state.tab]();
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  scrollTo(0, y);
}

// ---- events ----
view.addEventListener('input', (e) => {
  if (e.target.id === 'draft') state.draft = e.target.value;
  if (e.target.id === 'q') {
    state.q = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const q = $('#q');
    if (q) {
      q.focus();
      q.setSelectionRange(pos, pos);
    }
  }
});

view.addEventListener('keydown', (e) => {
  if (e.target.id === 'draft' && e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) {
    e.preventDefault();
    addTasks(state.draft);
  }
  if (e.target.dataset && e.target.dataset.a === 'open' && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openEdit(e.target.dataset.id);
  }
});

view.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset && el.dataset.set) {
    const k = el.dataset.set;
    state.settings[k] = k === 'defaultTime' ? el.value || '09:00' : Number(el.value);
    saveSettings();
    return;
  }
  if (el.id !== 'file' || !el.files[0]) return;
  try {
    const data = JSON.parse(await el.files[0].text());
    const incoming = (Array.isArray(data) ? data : data && data.tasks) || [];
    if (!Array.isArray(incoming)) throw new Error('bad');
    const ids = new Set(state.tasks.map((t) => t.id));
    const add = incoming.map(normalizeTask).filter((t) => t && !ids.has(t.id));
    state.tasks.push(...add);
    save();
    toast(`Imported ${add.length} task${add.length === 1 ? '' : 's'}.`);
  } catch {
    toast('That file is not a valid backup.');
  }
});

async function exportBackup() {
  const body = JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), tasks: state.tasks, settings: state.settings }, null, 2);
  const r = await deliver('planner-backup.json', 'application/json', body);
  if (r === 'shared' || r === 'downloaded') {
    state.settings.lastBackup = new Date().toISOString();
    saveSettings();
    render();
  } else if (r === 'unavailable') {
    toast('The share sheet did not open. Try again from a Safari tab.');
  }
}

document.addEventListener('click', async (e) => {
  const tab = e.target.closest('#tabs button');
  if (tab) {
    state.tab = tab.dataset.tab;
    scrollTo(0, 0);
    return render();
  }
  const b = e.target.closest('#view [data-a]');
  if (!b) return;
  if (b.tagName === 'A') e.preventDefault();
  const a = b.dataset.a;
  const id = b.dataset.id;
  if (a === 'add') addTasks(state.draft);
  else if (a === 'open') openEdit(id);
  else if (a === 'toggle') completeTask(find(id));
  else if (a === 'day') {
    state.sel = b.dataset.k;
    render();
  } else if (a === 'add-day') {
    state.forDate = state.sel;
    state.tab = 'tasks';
    scrollTo(0, 0);
    render();
    const d = $('#draft');
    if (d) d.focus();
  } else if (a === 'clear-for') {
    state.forDate = null;
    render();
  } else if (a === 'cal-all') sendToCalendar(state.tasks.filter((t) => !t.reminded && !t.done));
  else if (a === 'cal-recent') sendToCalendar(state.recent.map((r) => find(r.id)).filter(Boolean));
  else if (a === 'dismiss-recent') {
    state.recent = [];
    render();
  } else if (a === 'cat') {
    state.cat = b.dataset.c;
    render();
  } else if (a === 'toggle-done') {
    state.showDone = !state.showDone;
    render();
  } else if (a === 'clear-done') {
    const n = state.tasks.filter((t) => t.done).length;
    if (confirm(`Delete ${n} finished task${n === 1 ? '' : 's'}?`)) {
      state.tasks = state.tasks.filter((t) => !t.done);
      save();
      render();
    }
  } else if (a === 'hide-install') {
    state.hideInstall = true;
    store.set('planner.hideInstall', true);
    render();
  } else if (a === 'nag-later') {
    state.settings.nagUntil = new Date(Date.now() + 7 * 86400000).toISOString();
    saveSettings();
    render();
  } else if (a === 'save-key') {
    state.key = $('#key').value.trim();
    state.model = $('#model').value.trim();
    store.set('planner.apiKey', state.key);
    store.set('planner.model', state.model);
    toast('Saved.');
  } else if (a === 'test-dl' || a === 'test-open' || a === 'test-share') {
    const ics = buildICS(
      [{ id: 'test-' + Date.now(), title: 'Planner test', description: 'Test event from Claude Planner', due: new Date(Date.now() + 40 * 60000).toISOString() }],
      { alerts: alerts() },
    );
    if (a === 'test-dl') downloadFile('planner-test.ics', ICS_MIME, ics);
    else if (a === 'test-open') {
      if (isStandalone()) return toast('Open this page in a Safari tab (not the home-screen icon) to try this one.', 6000);
      location.href = URL.createObjectURL(new Blob([ics], { type: ICS_MIME }));
    } else {
      const r = await shareFile('planner-test.ics', ICS_MIME, ics);
      if (r === 'unavailable') toast('Share sheet not available here.');
    }
  } else if (a === 'export') exportBackup();
  else if (a === 'export-ics') {
    const list = state.tasks.filter((t) => t.repeat || (!t.done && new Date(t.due) > new Date()));
    if (!list.length) return toast('Nothing upcoming to export.');
    const r = await deliver('planner-upcoming.ics', ICS_MIME, buildICS(list, { alerts: alerts() }));
    if (r === 'unavailable') toast('The share sheet did not open. Try again from a Safari tab.');
  } else if (a === 'import') $('#file').click();
});

dlg.addEventListener('close', render);
setInterval(() => !dlg.open && state.tab === 'tasks' && document.activeElement?.id !== 'draft' && document.activeElement?.id !== 'q' && render(), 60000);

// ?add=Some+text pre-fills the box (handy for a Shortcut or bookmark). It never creates a task by itself.
try {
  const p = new URLSearchParams(location.search);
  if (p.get('add')) {
    state.draft = p.get('add').slice(0, 2000);
    history.replaceState(null, '', location.pathname);
  }
} catch {}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
render();
