# Call Bots

Put any number of **guests** into an Aloqa call from one computer. Each guest is
a real browser that opens the call's invite link, types a name, and publishes
real WebRTC audio and video from synthetic capture devices. At the product and
server level they are ordinary anonymous participants.

No accounts, no workspace, nothing to provision: the invite link is the only
input.

## Install

Needs **Node.js 20+**. macOS, Windows, and Linux all work; Google Chrome is used
when present, otherwise Chromium is downloaded on install.

```bash
npm install
npm start          # opens the app at http://127.0.0.1:4610
```

`npm run doctor` checks the browser, speech engine, and how many guests this
machine can carry. On macOS, `npm run build:app` produces a double-click
**Call Bots.app** (bundled Node runtime, no terminal needed).

## Using it

1. Start a call in Aloqa and copy its **invite link** (the "Add to call" panel).
2. Paste it, choose how many guests, press **Send guests**.
3. Guests appear as cards with a live view of what each one sees. Mute, toggle
   cameras, share a screen, or remove a guest — individually or for all of them.
   **Add guests** puts more into the same call; **Stop** ends the session and
   closes every browser.

Terminal equivalent:

```bash
node src/cli.mjs join "<invite-link>" --guests 4
```

## What each guest publishes

- **Video**: one shared 1920x1080 clip rendered in pure Node — aurora ribbons
  behind a circular visualiser with a live timecode, so a frozen tile is
  obvious. Rendered once and reused by every guest.
- **Audio**: a looping 48 kHz track per guest, each with a different system
  voice and line, offset so the active speaker rotates.

Regenerate with `node src/cli.mjs fixtures --regen`; `--size`/`--fps` tune the
video (1080p is heavy — try `--size 1280x720` for more guests at once).

## Notes

- The realistic ceiling is what `doctor` reports for your machine (measured from
  RAM and cores, about 6 on a 16 GB laptop). Beyond it, CPU contention degrades
  the media itself.
- The call must admit guests without approval (entry mode **Open**); otherwise
  the app reports that the host needs to admit them.
- Guests are anonymous, so each browser is always a fresh context — a signed-in
  cookie would make the invite page join as that account instead.
- Selector drift after an Aloqa deploy: every selector lives in
  `src/selectors.mjs`.
- `npm run clean` kills leftover guest browsers after a hard kill.
