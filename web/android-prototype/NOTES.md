# Android Interaction Prototype

Status: disposable, awaiting user feedback. Uses the already selected A visual direction rather than introducing competing visual themes.

Question: Do the personal Android client's image/emoticon chat and notification-to-conversation workflows feel right before implementing an APK?

Target device: HONOR WIN RT, MagicOS 10, Android 16. Planned real transport: user-configured public HTTPS backend. Group chat is out of scope.

## Preview

Open `index.html` directly, or from the repository root run:

```sh
python -m http.server 18349 --directory web
```

Then open `http://localhost:18349/android-prototype/`.

The browser prototype is isolated because there is no Android app yet and prototype actions must never reach authenticated production mutations. The production web build excludes this directory.

Screens are selected with `?screen=inbox|chat|lock|settings|server|login|friends`. Bottom arrows cycle through core flows. Desktop side controls, or the bottom sliders button on phones, simulate incoming messages, network loss/recovery and lock screen entry.

## Working Interactions

- Mock HTTPS address validation and mock login. No network connection or real password verification.
- Conversation/friend search, unread filter and selection.
- In-memory text messages and pending-send state when disconnected.
- Local image selection, attachment preview, removal, sending and full-size viewing.
- Steam emoticon images, Unicode emoji, and illustrative sticker-style messages.
- Page-rendered message notifications, open/reply navigation and mark-as-read.
- Simulated offline queue and catch-up on reconnect.
- Notification preview/privacy toggles and background-receive demonstration.

## Boundaries

This is NOT an APK, WebView wrapper, system notification test, Android background service, real Steam login or backend integration. The lock screen is a visual approximation, not a promise that MagicOS will display this exact layout. No data is persisted and no messages, selected photos or login inputs are transmitted. Do not enter real passwords.

Initial conversations, unread counts, game activity and timestamps are fixture data. The sticker tab uses illustrative Unicode artwork, not a real Steam sticker inventory. Selected local images use browser object URLs and live only in memory. Assets and Lucide icons are reused from `../prototype/assets`; Steam emoticon PNGs are stored in `assets/`.

Prior backend-sync implementation work was removed from the worktree when the user narrowed scope to a prototype. It is not part of this deliverable.

Validation: Chromium at widths 320, 390, 768 and 1440; screenshots inspected; image decode, file selection, emoticons, stickers, notification navigation, offline queue, privacy toggle and simulated configuration/login exercised.

Decision pending: confirm these flows before building native Android UI, real transport, secure credential storage and foreground-service notifications. HONOR lock-screen delivery and battery impact require a real-device test.
