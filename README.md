# Claude Planner

A phone planner (Expo / React Native, iOS + Android).

- **AI task creation** – type a note like `Dentist next Friday 3pm, bring insurance card`; Claude turns it into a title, brief description and due date/time. Without an API key it falls back to a basic built-in parser.
- **Reminders** – every task schedules a local phone notification 30 minutes before it's due (works offline).
- **Year view** – a 12‑month calendar heat map; darker days have more tasks. Tap a day to see, complete or delete its tasks.

## Run it on your phone
1. Install **Expo Go** from the App Store / Play Store.
2. `npm install && npx expo start`, then scan the QR code (phone and computer on the same Wi‑Fi).
3. Open **Settings** in the app and paste your Anthropic API key (stored in the phone's secure storage, sent only to api.anthropic.com).
4. Allow notifications when prompted.

For a standalone install use EAS Build (`npx eas build`). Reminders are most reliable in a standalone build.

## Notes
- Data lives on the device (AsyncStorage). iOS caps pending notifications at 64, so the soonest 60 are scheduled and resynced each time the app opens or a task changes.
- Tests for the parser and year grid: `npm test`.
