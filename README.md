# Claude Planner

A phone planner (Expo / React Native, iOS + Android).

- **AI task creation** – type a note like `Dentist next Friday 3pm, bring insurance card`; Claude turns it into a title, brief description and due date/time. Without an API key it falls back to a basic built-in parser.
- **Reminders** – every task schedules a local phone notification 30 minutes before it's due (works offline).
- **Year view** – a 12‑month calendar heat map; darker days have more tasks. Tap a day to see, complete or delete its tasks.

## Which version?
- **`docs/` – installable web app (free, iPhone only).** Runs from the home screen with no Mac or server. Reminders go through the Calendar app (see below).
- **Expo app (root)** – native local notifications, but needs your computer's dev server unless you pay for an Apple developer account and make a standalone build.

## Web app: publish and install
1. Publish `docs/` with GitHub Pages: repo **Settings → Pages → Build and deployment → Deploy from a branch**, pick this branch and the **/docs** folder, Save. (Pages is free only for public repos.) The site appears at `https://<user>.github.io/<repo>/` after a few minutes.
2. On the iPhone open that address in Safari → Share → **Add to Home Screen** (keep *Open as Web App* on). Open it from the icon and add your API key and tasks there – the icon and Safari do not share data.
3. Create a task, then tap **Save & add 30-min reminder to Calendar** and confirm in the sheet that appears. Calendar then alerts you 30 minutes before, even when the app is closed.

A web app on iPhone cannot schedule its own notifications, which is why reminders go through Calendar (one tap per task). Fully automatic reminders would need a push server or a native app.

AI is optional: without a key the app uses its built-in parser. The model name is editable in Settings.

## Run the Expo app on your phone
1. Install **Expo Go** from the App Store / Play Store.
2. `npm install && npx expo start`, then scan the QR code (phone and computer on the same Wi‑Fi).
3. Open **Settings** in the app and paste your Anthropic API key (stored in the phone's secure storage, sent only to api.anthropic.com).
4. Allow notifications when prompted.

For a standalone install use EAS Build (`npx eas build`). Reminders are most reliable in a standalone build.

## Notes
- Data lives on the device (AsyncStorage). iOS caps pending notifications at 64, so the soonest 60 are scheduled and resynced each time the app opens or a task changes.
- Tests for the parser and year grid: `npm test`.
