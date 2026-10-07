import { createTaskFromText, toLocalString, fromLocalString, DEFAULT_MODEL } from './ai.js';
import { buildICS } from './ics.js';
import { buildYear, countByDay, dayKey } from './year.js';

const LEAD = 30;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

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

const state = {
  tasks: store.get('planner.tasks.v1', []),
  key: store.get('planner.apiKey', ''),
  model: store.get('planner.model', ''),
  tab: 'tasks',
  sel: dayKey(new Date()),
  busy: false,
  note: '',
  draft: '',
  hideInstall: store.get('planner.hideInstall', false),
};

const $ = (s) => document.querySelector(s);
const view = $('#view');
const dlg = $('#edit');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (iso) =>
  new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const save = () => store.set('planner.tasks.v1', state.tasks);
const byDue = (a, b) => new Date(a.due) - new Date(b.due);

function toast(msg, ms = 4000) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => (t.hidden = true), ms);
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
  const list = tasks.filter((t) => !t.done && new Date(t.due) > new Date());
  if (!list.length) return toast('Nothing upcoming to add.');
  const r = await deliver(list.length === 1 ? 'task.ics' : 'planner-tasks.ics', 'text/calendar;charset=utf-8', buildICS(list, { lead: LEAD }));
  if (r === 'cancelled') return;
  if (r === 'unavailable') return toast('The share sheet did not open. Open this page in Safari (not the home-screen icon) and try again.', 8000);
  if (r === 'downloaded') toast('If no “Add to Calendar” sheet appeared, tap the download arrow in Safari’s address bar and open the file. See Settings → Calendar methods.', 9000);
  list.forEach((t) => (t.reminded = true));
  save();
  render();
  if (r === 'shared') toast('Choose Calendar in the share sheet to finish.', 7000);
}

// ---- tasks ----
async function addTask(text) {
  if (!text.trim() || state.busy) return;
  state.busy = true;
  render();
  const r = await createTaskFromText(text, state.key, new Date(), state.model || DEFAULT_MODEL);
  const task = { id: newId(), title: r.title, description: r.description, due: r.due.toISOString(), done: false, reminded: false };
  state.tasks.push(task);
  save();
  state.busy = false;
  state.draft = '';
  state.note =
    r.source === 'local' ? (state.key ? 'AI unavailable (' + (r.aiError || 'error') + '), used basic parsing — check the time.' : 'Used basic parsing (add an API key in Settings for AI).') : '';
  render();
  openEdit(task.id, true);
}

function openEdit(id, fresh = false) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  dlg.innerHTML = `
    <h2 style="margin:0 0 4px">${fresh ? 'Task created' : 'Edit task'}</h2>
    ${fresh ? '<p class="note" style="margin-top:0">Check the details, then add the reminder to your Calendar.</p>' : ''}
    <label>Title</label><input id="e-title" value="${esc(t.title)}">
    <label>Details</label><textarea id="e-desc">${esc(t.description)}</textarea>
    <label>When</label><input id="e-due" type="datetime-local" value="${toLocalString(new Date(t.due))}">
    <button data-a="e-cal" data-id="${t.id}">🔔 Save &amp; add ${LEAD}-min reminder to Calendar</button>
    <button class="sec" data-a="e-save" data-id="${t.id}">Save</button>
    <button class="sec" data-a="e-done" data-id="${t.id}">${t.done ? 'Mark not done' : 'Mark done'}</button>
    <button class="bad" data-a="e-del" data-id="${t.id}">Delete</button>
    ${t.reminded ? '<p class="note">A reminder for the old time may already be in Calendar — if you change the time, delete the old event there.</p>' : ''}`;
  dlg.showModal();
}

function readEdit(id) {
  const t = state.tasks.find((x) => x.id === id);
  const due = fromLocalString($('#e-due').value);
  t.title = $('#e-title').value.trim() || t.title;
  t.description = $('#e-desc').value.trim();
  if (due && due.toISOString() !== t.due) {
    t.due = due.toISOString();
    t.reminded = false;
    t.uid = newId(); // Calendar ignores an updated event that reuses a UID, so rescheduled tasks get a new one
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
    render();
  } else if (a === 'e-cal') {
    const t = readEdit(id);
    dlg.close();
    render();
    sendToCalendar([t]);
  } else if (a === 'e-done') {
    const t = state.tasks.find((x) => x.id === id);
    t.done = !t.done;
    save();
    dlg.close();
    render();
  } else if (a === 'e-del' && confirm('Delete this task?')) {
    state.tasks = state.tasks.filter((x) => x.id !== id);
    save();
    dlg.close();
    render();
  }
});

// ---- views ----
function taskRow(t) {
  return `<div class="row">
    <button class="chk ${t.done ? 'on' : ''}" data-a="toggle" data-id="${t.id}" aria-label="Toggle done"></button>
    <div class="t" data-a="open" data-id="${t.id}">
      <div class="name ${t.done ? 'done' : ''}">${esc(t.title)}</div>
      ${t.description ? `<div class="desc">${esc(t.description)}</div>` : ''}
      <div class="when">${esc(fmt(t.due))}${t.reminded ? ' · 🔔' : ''}</div>
    </div></div>`;
}

function installHint() {
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (standalone || state.hideInstall) return '';
  return `<div class="card"><b>Install it</b><div class="note">In Safari tap the Share button, then <b>Add to Home Screen</b> (leave <b>Open as Web App</b> on). Then open it from the icon and add your key and tasks there — the icon and Safari do not share data.</div>
    <button class="sec" data-a="hide-install">Got it</button></div>`;
}

function tasksView() {
  const now = Date.now();
  const soon = state.tasks.filter((t) => !t.done && new Date(t.due) - now <= LEAD * 60000 && new Date(t.due) - now > -3600000).sort(byDue);
  const sorted = [...state.tasks].sort((a, b) => Number(a.done) - Number(b.done) || byDue(a, b));
  const pending = state.tasks.filter((t) => !t.done && !t.reminded && new Date(t.due) > now);
  return `<h1>Planner</h1>
    ${installHint()}
    ${soon.length ? `<div class="card soon"><b>⏰ Starting soon</b>${soon.map((t) => `<div>${esc(t.title)} — ${esc(fmt(t.due))}</div>`).join('')}</div>` : ''}
    <div class="card">
      <textarea id="draft" placeholder="e.g. Dentist next Friday 3pm — bring insurance card">${esc(state.draft)}</textarea>
      <button data-a="add" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Working…' : '✨ Create task'}</button>
      ${state.note ? `<p class="note">${esc(state.note)}</p>` : ''}
    </div>
    ${pending.length ? `<button class="sec" data-a="cal-all" style="margin:0 0 14px">🔔 Add ${pending.length} task${pending.length > 1 ? 's' : ''} without a reminder to Calendar</button>` : ''}
    <div class="card">${sorted.length ? sorted.map(taskRow).join('') : '<p class="mute" style="text-align:center">No tasks yet. Describe one above.</p>'}</div>`;
}

function yearView() {
  const months = buildYear(new Date());
  const counts = countByDay(state.tasks);
  const today = dayKey(new Date());
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const day = state.tasks.filter((t) => dayKey(new Date(t.due)) === state.sel).sort(byDue);
  const selLabel = new Date(state.sel + 'T00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  return `<h1>Next 12 months</h1>
    <p class="mute" style="margin-top:0">${total} upcoming task${total === 1 ? '' : 's'} · tap a day</p>
    <div class="card"><div class="when" style="font-weight:600;color:var(--brand)">${esc(selLabel)}</div>
      ${day.length ? day.map(taskRow).join('') : '<p class="mute">Nothing planned.</p>'}</div>
    ${months
      .map(
        ({ first, weeks }) => `<div class="card month"><h3>${MONTHS[first.getMonth()]} ${first.getFullYear()}</h3>
      <div class="grid">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<div class="dow">${d}</div>`).join('')}
      ${weeks
        .flat()
        .map((d) => {
          if (!d) return '<div class="day blank"></div>';
          const k = dayKey(d);
          const n = Math.min(counts[k] || 0, 4);
          return `<button class="day h${n} ${k === today ? 'today' : ''} ${k === state.sel ? 'sel' : ''}" data-a="day" data-k="${k}">${d.getDate()}</button>`;
        })
        .join('')}</div></div>`,
      )
      .join('')}
    <div class="legend"><span class="mute">Fewer</span>${[0, 1, 2, 3, 4].map((i) => `<i style="background:var(--h${i})"></i>`).join('')}<span class="mute">More</span></div>`;
}

function settingsView() {
  return `<h1>Settings</h1>
    <div class="card"><b>Anthropic API key (optional)</b>
      <p class="note">Lets Claude read your notes and fill in the title, details and time. Without it the app uses simple built-in parsing. The key stays on this phone and is sent only to api.anthropic.com. Anyone who can unlock this phone and open the app could read it.</p>
      <input id="key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(state.key)}">
      <label>Model</label>
      <input id="model" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc(DEFAULT_MODEL)}" value="${esc(state.model)}">
      <p class="note">Leave blank for ${esc(DEFAULT_MODEL)}. If AI stops working, a model may have been retired — try another current model name.</p>
      <button data-a="save-key">Save</button></div>
    <div class="card"><b>Reminders</b>
      <p class="note">iPhone web apps can't schedule their own alerts, so each task is sent to the Calendar app as an event with an alert ${LEAD} minutes before. Calendar then notifies you even when this app is closed.</p></div>
    <div class="card"><b>Calendar methods</b>
      <p class="note">If a task's “add to Calendar” button doesn't bring up Calendar's Add screen, try each of these. Each sends a test event 40 minutes from now with a ${LEAD}-minute alert.</p>
      <button class="sec" data-a="test-dl">1. Download link (use in Safari)</button>
      <button class="sec" data-a="test-open">2. Open file in this tab (use in Safari)</button>
      <button class="sec" data-a="test-share">3. Share sheet</button></div>
    <div class="card"><b>Backup</b>
      <p class="note">Tasks live in this app's storage on your phone. Save a backup now and then.</p>
      <button class="sec" data-a="export">Export backup</button>
      <button class="sec" data-a="import">Import backup</button>
      <input id="file" type="file" accept=".json,application/json" hidden></div>`;
}

function render() {
  if (dlg.open) return;
  const y = scrollY;
  view.innerHTML = { tasks: tasksView, year: yearView, settings: settingsView }[state.tab]();
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  scrollTo(0, y);
}

view.addEventListener('input', (e) => {
  if (e.target.id === 'draft') state.draft = e.target.value;
});

view.addEventListener('change', async (e) => {
  if (e.target.id !== 'file' || !e.target.files[0]) return;
  try {
    const data = JSON.parse(await e.target.files[0].text());
    if (!Array.isArray(data)) throw new Error('bad');
    const ids = new Set(state.tasks.map((t) => t.id));
    const add = data.filter((t) => t && t.id && t.title && !isNaN(new Date(t.due)) && !ids.has(t.id));
    state.tasks.push(...add);
    save();
    toast(`Imported ${add.length} task${add.length === 1 ? '' : 's'}.`);
  } catch {
    toast('That file is not a valid backup.');
  }
});

document.addEventListener('click', async (e) => {
  const tab = e.target.closest('#tabs button');
  if (tab) {
    state.tab = tab.dataset.tab;
    scrollTo(0, 0);
    return render();
  }
  const b = e.target.closest('#view [data-a]');
  if (!b) return;
  const a = b.dataset.a;
  const id = b.dataset.id;
  if (a === 'add') addTask(state.draft);
  else if (a === 'open') openEdit(id);
  else if (a === 'toggle') {
    const t = state.tasks.find((x) => x.id === id);
    t.done = !t.done;
    save();
    render();
  } else if (a === 'day') {
    state.sel = b.dataset.k;
    render();
  } else if (a === 'cal-all') sendToCalendar(state.tasks.filter((t) => !t.reminded));
  else if (a === 'hide-install') {
    state.hideInstall = true;
    store.set('planner.hideInstall', true);
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
      { lead: LEAD },
    );
    if (a === 'test-dl') downloadFile('planner-test.ics', ICS_MIME, ics);
    else if (a === 'test-open') {
      if (isStandalone()) return toast('Open this page in a Safari tab (not the home-screen icon) to try this one.', 6000);
      location.href = URL.createObjectURL(new Blob([ics], { type: ICS_MIME }));
    } else {
      const r = await shareFile('planner-test.ics', ICS_MIME, ics);
      if (r === 'unavailable') toast('Share sheet not available here.');
    }
  } else if (a === 'export') deliver('planner-backup.json', 'application/json', JSON.stringify(state.tasks, null, 2));
  else if (a === 'import') $('#file').click();
});

dlg.addEventListener('close', render);
setInterval(() => !dlg.open && state.tab === 'tasks' && document.activeElement?.id !== 'draft' && render(), 60000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
render();
