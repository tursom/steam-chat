# Steam Chat UI Prototype

Question: Which chat layout should guide the production UI redesign?

Status: Archived design reference. The user selected A with a collapsible friend-details panel. Production implementation lives in `../app.ts` and `../style.css`; these mock variants are not shipped by the production build.

Open `index.html` directly in a browser. No server, installation, account, database or network access is required. Switch with the bottom arrows or the left/right keyboard keys outside input fields. The `variant` URL parameter accepts A, B or C.

- A: Light chat-first workspace, narrow tool rail and bubble messages.
- B: Dark gaming client, flat message timeline and visible friend/game details.
- C: Shared inbox, workspace navigation and active account context.

The isolated page is intentional: the real app requires authenticated Steam account context. This prototype must not mutate accounts or send real messages. The production build copies only the existing app files and icons, not this directory.

Conversation names, online state, unread badges, game activity, assignment and message timestamps are mock data. Team assignment and game library views are exploratory concepts, not claims about implemented functionality. Local messages are memory-only and never sent. Management actions are placeholders. Group chat remains explicitly unavailable.

Screenshots: `A-desktop.png`, `B-desktop.png`, `C-desktop.png`, corresponding `*-mobile.png` conversation views and `*-mobile-list.png` lists.

Assets: Dota 2, Counter-Strike 2 and Stardew Valley promotional images from Steam's public CDN, used only as game-link preview examples. Icons: Lucide 0.468.0 (ISC license, bundled distribution).

Validation: Chromium at 1440x1000 and 390x844; image loading, page overflow, search, conversation selection, local message submission, back navigation and variant switching checked.

Decision: A selected, with an optional friend-details panel inspired by B. The production UI uses real friend/account data, a narrow navigation rail, and an overlay details drawer on small screens. Mock unread counts, team assignments, game library and invented profile metadata were not promoted. This directory is retained only as an archived visual reference.
