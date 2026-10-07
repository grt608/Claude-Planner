# Claude Planner

A task planner for your phone. Type a note, get a task with a date, time and reminder, and see the whole year at a glance.

There are two versions that share the same parsing code:

- **`docs/` – installable web app (free, iPhone only).** Runs from the home screen with no Mac or server. Reminders go through the Calendar app.
- **Expo app (repo root)** – native local notifications, but it needs your computer's dev server unless you pay for an Apple developer account and make a standalone build. It does not support repeating tasks.

## What the web app does
- **Create tasks from plain text.** `Dentist next Friday 3pm — bring insurance card`, `Study for exam fri 7pm for 2 hours #school`, `Gym every monday and wednesday 6am`, `Call mom in 30 minutes`. Without an API key a built-in parser handles it; with an Anthropic key Claude does.
- **Several tasks in one message** – one per line, or comma-separated (`dentist fri 3pm, groceries sat, call mom tonight`).
- **Understands:** `tmrw`, weekdays (`fri`, `next monday`), dates (`Oct 20`, `3/5`, `the 15th`, `2026-11-02`), `tonight`, `noon`, `in 2 hours`, `next week`, ranges (`2-3pm`), lengths (`for 90 min`), repeats (`every weekday`, `every 2 weeks`), `#tags`.
- **Never guesses silently.** If it can't find a date, can't tell am from pm, or the time has already passed, a warning is shown on the new task.
- **Repeating tasks** are exported with a repeat rule, so one calendar import covers every future reminder. Checking one off moves it to its next time.
- **Reminders:** each task is sent to the Calendar app with alerts you choose in Settings (default 30 minutes before, optional second alert such as a day before).
- **Year view:** 12 months, darker days have more tasks (repeats are counted each time). Tap a day to see its tasks or add one there.
- **Also:** search and `#category` filter, overdue / today / upcoming / done sections, snooze (+1 hour, tomorrow, next week), undo delete, backup/restore, dark mode, works offline.
- **`?add=` link:** opening the app with `?add=Buy+milk+tomorrow` pre-fills the box (handy for a Shortcuts action or bookmark). It never creates a task by itself.

## Web app: publish and install
1. Publish `docs/` with GitHub Pages: repo **Settings → Pages → Build and deployment → Deploy from a branch**, pick this branch and the **/docs** folder, Save. (Pages is free only for public repos.) The site appears at `https://<user>.github.io/<repo>/` after a few minutes.
2. On the iPhone open that address in Safari → Share → **Add to Home Screen** (keep *Open as Web App* on). Open it from the icon and add your API key and tasks there – the icon and Safari do not share data.
3. Create a task, then tap **Save & add reminder to Calendar** and confirm in the sheet that appears. Calendar then alerts you before it starts, even when the app is closed.

A web app on iPhone cannot schedule its own notifications, which is why reminders go through Calendar (one tap per task, or per batch). Fully automatic reminders would need a push server or a native app. If the Add to Calendar screen does not appear, **Settings → Calendar methods** has three alternatives to try.

AI is optional and costs money per use (the API is prepaid). The model name is editable in Settings. The key stays on your phone and is sent only to api.anthropic.com.

## Run the Expo app on your phone
1. Install **Expo Go** from the App Store / Play Store and sign in to the same Expo account as `npx expo login`.
2. `npm install && npx expo start`, then scan the QR code (phone and computer on the same Wi‑Fi).
3. Open **Settings** in the app and paste your Anthropic API key (stored in the phone's secure storage, sent only to api.anthropic.com).
4. Allow notifications when prompted.

For a standalone install use EAS Build (`npx eas build`). Reminders are most reliable in a standalone build. iOS caps pending notifications at 64, so the soonest 60 are scheduled and resynced each time the app opens or a task changes.

## Development
- `npm test` – parser (including 170 independently written cases), repeat rules, calendar files, AI client, and a check that the shared modules stay in sync.
- `npm run sync` – copies the shared modules from `docs/` to `src/` for the Expo app. Edit them in `docs/` only.
- Data lives on the device (browser storage for the web app, AsyncStorage for Expo). Use **Settings → Export backup** now and then.
