import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export const LEAD_MINUTES = 30;
// iOS keeps at most 64 pending local notifications, so only the soonest are scheduled.
const MAX_SCHEDULED = 60;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function setupNotifications() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('reminders', {
      name: 'Task reminders',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  const { status } = await Notifications.getPermissionsAsync();
  if (status === 'granted') return true;
  return (await Notifications.requestPermissionsAsync()).status === 'granted';
}

export function reminderTime(due, now = Date.now()) {
  const t = new Date(due).getTime();
  if (t <= now) return null; // already past
  const at = t - LEAD_MINUTES * 60 * 1000;
  // Less than 30 min away: remind in a few seconds instead of skipping.
  return new Date(at > now ? at : now + 5000);
}

const pad = (n) => String(n).padStart(2, '0');

/** Rebuild all pending reminders from the task list (idempotent). */
export async function syncReminders(tasks) {
  await Notifications.cancelAllScheduledNotificationsAsync();
  const now = Date.now();
  const upcoming = tasks
    .filter((t) => !t.done)
    .map((t) => ({ t, at: reminderTime(t.due, now) }))
    .filter((x) => x.at)
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_SCHEDULED);

  for (const { t, at } of upcoming) {
    const due = new Date(t.due);
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `Up next: ${t.title}`,
        body: `${t.description ? t.description + ' · ' : ''}Starts at ${due.getHours() % 12 || 12}:${pad(due.getMinutes())} ${due.getHours() >= 12 ? 'PM' : 'AM'}`,
        sound: true,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: at,
        channelId: 'reminders',
      },
    });
  }
}
