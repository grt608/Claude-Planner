import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform, Pressable,
  SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { createTaskFromText } from './src/ai.js';
import { loadApiKey, loadTasks, saveApiKey, saveTasks } from './src/storage.js';
import { LEAD_MINUTES, setupNotifications, syncReminders } from './src/reminders.js';
import { buildYear, countByDay, dayKey } from './src/year.js';

const C = { bg: '#f6f6fb', card: '#fff', ink: '#1c1b29', mute: '#6b6a80', brand: '#4f46e5', line: '#e4e3ef' };
const HEAT = ['#ebeaf5', '#c7d2fe', '#818cf8', '#4f46e5', '#312e81'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const fmt = (iso) =>
  new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export default function App() {
  const [tab, setTab] = useState('tasks');
  const [tasks, setTasks] = useState([]);
  const [apiKey, setApiKey] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      const [t, k] = await Promise.all([loadTasks(), loadApiKey()]);
      setTasks(t);
      setApiKey(k || '');
      await setupNotifications();
      await syncReminders(t);
      setReady(true);
    })();
  }, []);

  const update = useCallback(async (next) => {
    setTasks(next);
    await saveTasks(next);
    await syncReminders(next);
  }, []);

  if (!ready) return <View style={[s.fill, s.center]}><ActivityIndicator color={C.brand} /></View>;

  return (
    <SafeAreaView style={s.fill}>
      <StatusBar style="dark" />
      <View style={s.fill}>
        {tab === 'tasks' && <TasksScreen tasks={tasks} update={update} apiKey={apiKey} />}
        {tab === 'year' && <YearScreen tasks={tasks} update={update} />}
        {tab === 'settings' && <SettingsScreen apiKey={apiKey} setApiKey={setApiKey} />}
      </View>
      <View style={s.tabs}>
        {[['tasks', 'Tasks'], ['year', 'Year'], ['settings', 'Settings']].map(([k, label]) => (
          <Pressable key={k} style={s.tab} onPress={() => setTab(k)}>
            <Text style={[s.tabText, tab === k && { color: C.brand, fontWeight: '700' }]}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

function TaskRow({ task, onToggle, onDelete }) {
  return (
    <View style={s.row}>
      <Pressable onPress={onToggle} style={[s.check, task.done && { backgroundColor: C.brand }]} />
      <View style={{ flex: 1 }}>
        <Text style={[s.title, task.done && s.done]}>{task.title}</Text>
        {!!task.description && <Text style={s.desc}>{task.description}</Text>}
        <Text style={s.when}>{fmt(task.due)}</Text>
      </View>
      <Pressable onPress={onDelete} hitSlop={10}><Text style={s.del}>✕</Text></Pressable>
    </View>
  );
}

function useTaskActions(tasks, update) {
  const toggle = (id) => update(tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  const remove = (id) =>
    Alert.alert('Delete task?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => update(tasks.filter((t) => t.id !== id)) },
    ]);
  return { toggle, remove };
}

function TasksScreen({ tasks, update, apiKey }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const { toggle, remove } = useTaskActions(tasks, update);

  const sorted = useMemo(
    () => [...tasks].sort((a, b) => Number(a.done) - Number(b.done) || new Date(a.due) - new Date(b.due)),
    [tasks],
  );

  const add = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setNote('');
    const r = await createTaskFromText(text, apiKey);
    const task = { id: String(Date.now()), title: r.title, description: r.description, due: r.due.toISOString(), done: false };
    await update([...tasks, task]);
    setText('');
    setNote(
      `Added “${r.title}” for ${fmt(task.due)}. Reminder ${LEAD_MINUTES} min before.` +
        (r.source === 'local' ? (apiKey ? ' (AI unavailable — used basic parsing)' : ' (add an API key in Settings for AI)') : ''),
    );
    setBusy(false);
  };

  return (
    <KeyboardAvoidingView style={s.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={s.compose}>
        <Text style={s.h1}>Planner</Text>
        <TextInput
          style={s.input}
          value={text}
          onChangeText={setText}
          placeholder="e.g. Dentist next Friday 3pm — bring insurance card"
          placeholderTextColor={C.mute}
          multiline
        />
        <Pressable style={[s.btn, busy && { opacity: 0.6 }]} onPress={add} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>✨ Create task</Text>}
        </Pressable>
        {!!note && <Text style={s.note}>{note}</Text>}
      </View>
      <FlatList
        data={sorted}
        keyExtractor={(t) => t.id}
        contentContainerStyle={{ padding: 16, paddingTop: 4 }}
        ListEmptyComponent={<Text style={s.empty}>No tasks yet. Describe one above.</Text>}
        renderItem={({ item }) => <TaskRow task={item} onToggle={() => toggle(item.id)} onDelete={() => remove(item.id)} />}
      />
    </KeyboardAvoidingView>
  );
}

function YearScreen({ tasks, update }) {
  const { width } = useWindowDimensions();
  const cell = Math.floor((width - 32 - 24) / 7);
  const months = useMemo(() => buildYear(new Date()), []);
  const counts = useMemo(() => countByDay(tasks), [tasks]);
  const [sel, setSel] = useState(dayKey(new Date()));
  const { toggle, remove } = useTaskActions(tasks, update);
  const todayKey = dayKey(new Date());
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const dayTasks = tasks.filter((t) => dayKey(new Date(t.due)) === sel).sort((a, b) => new Date(a.due) - new Date(b.due));

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Text style={s.h1}>Next 12 months</Text>
      <Text style={s.mute}>{total} upcoming task{total === 1 ? '' : 's'} · tap a day to see details</Text>

      <View style={s.card}>
        <Text style={s.when}>{new Date(sel + 'T00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</Text>
        {dayTasks.length === 0 && <Text style={s.empty}>Nothing planned.</Text>}
        {dayTasks.map((t) => <TaskRow key={t.id} task={t} onToggle={() => toggle(t.id)} onDelete={() => remove(t.id)} />)}
      </View>

      {months.map(({ first, weeks }) => (
        <View key={first.toISOString()} style={s.card}>
          <Text style={s.month}>{MONTHS[first.getMonth()]} {first.getFullYear()}</Text>
          <View style={s.weekRow}>
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <Text key={i} style={[s.dow, { width: cell }]}>{d}</Text>)}
          </View>
          {weeks.map((w, i) => (
            <View key={i} style={s.weekRow}>
              {w.map((d, j) => {
                if (!d) return <View key={j} style={{ width: cell, height: cell }} />;
                const k = dayKey(d);
                const n = Math.min(counts[k] || 0, 4);
                return (
                  <Pressable
                    key={j}
                    onPress={() => setSel(k)}
                    style={[
                      s.day,
                      { width: cell - 3, height: cell - 3, margin: 1.5, backgroundColor: HEAT[n] },
                      k === todayKey && { borderWidth: 2, borderColor: C.ink },
                      k === sel && { borderWidth: 2, borderColor: '#f59e0b' },
                    ]}
                  >
                    <Text style={[s.dayNum, n >= 2 && { color: '#fff' }]}>{d.getDate()}</Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      ))}
      <View style={s.legend}>
        <Text style={s.mute}>Fewer </Text>
        {HEAT.map((c) => <View key={c} style={[s.swatch, { backgroundColor: c }]} />)}
        <Text style={s.mute}> More</Text>
      </View>
    </ScrollView>
  );
}

function SettingsScreen({ apiKey, setApiKey }) {
  const [draft, setDraft] = useState(apiKey);
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Text style={s.h1}>Settings</Text>
      <View style={s.card}>
        <Text style={s.title}>Anthropic API key</Text>
        <Text style={s.desc}>
          Used to turn your notes into tasks with Claude. Stored only in this phone's secure storage and sent only to api.anthropic.com. Without a key the app falls back to simple built-in parsing.
        </Text>
        <TextInput
          style={[s.input, { marginTop: 10, minHeight: 0 }]}
          value={draft}
          onChangeText={setDraft}
          placeholder="sk-ant-..."
          placeholderTextColor={C.mute}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable
          style={s.btn}
          onPress={async () => {
            const k = draft.trim();
            await saveApiKey(k);
            setApiKey(k);
            Alert.alert('Saved');
          }}
        >
          <Text style={s.btnText}>Save</Text>
        </Pressable>
      </View>
      <View style={s.card}>
        <Text style={s.title}>Reminders</Text>
        <Text style={s.desc}>
          Every task schedules a phone notification {LEAD_MINUTES} minutes before its time (immediately if it starts sooner). Make sure notifications are allowed for this app. iOS limits pending alerts to 64, so the soonest 60 are scheduled and the rest are added as you reopen the app.
        </Text>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  h1: { fontSize: 28, fontWeight: '800', color: C.ink, marginBottom: 8 },
  mute: { color: C.mute, marginBottom: 12 },
  compose: { padding: 16, paddingBottom: 8 },
  input: { backgroundColor: C.card, borderRadius: 12, borderWidth: 1, borderColor: C.line, padding: 12, fontSize: 16, minHeight: 64, color: C.ink },
  btn: { backgroundColor: C.brand, borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 10 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  note: { color: C.mute, marginTop: 8 },
  empty: { color: C.mute, textAlign: 'center', marginVertical: 16 },
  card: { backgroundColor: C.card, borderRadius: 14, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: C.line },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: C.brand },
  title: { fontSize: 16, fontWeight: '600', color: C.ink },
  done: { textDecorationLine: 'line-through', color: C.mute },
  desc: { color: C.mute, marginTop: 2 },
  when: { color: C.brand, marginTop: 2, fontWeight: '600' },
  del: { color: C.mute, fontSize: 18 },
  month: { fontSize: 17, fontWeight: '700', color: C.ink, marginBottom: 6 },
  weekRow: { flexDirection: 'row' },
  dow: { textAlign: 'center', color: C.mute, fontSize: 12, marginBottom: 2 },
  day: { borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  dayNum: { fontSize: 12, color: C.ink },
  legend: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  swatch: { width: 16, height: 16, borderRadius: 4, marginHorizontal: 2 },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.card },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 14 },
  tabText: { color: C.mute, fontSize: 15 },
});
