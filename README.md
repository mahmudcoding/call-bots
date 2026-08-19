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

## What each bot publishes

- **Video**: bright, detailed 1920x1080 clips drawn in a real browser canvas, so
  the text is properly anti-aliased and the gradients are smooth. Each one packs
  saturated colour bars, a resolution star, fine gratings, a black-to-white ramp
  and a moving subject — the things a codec sacrifices first — so when the
  network degrades you can see it in the received picture immediately. There are
  five themes and bots cycle through them, rendered on demand and cached.
- **Audio**: continuous natural speech, a different system voice and a different
  passage per bot, so a call sounds like a room of people rather than one clip
  playing five times.

Rebuild the media with `node src/cli.mjs fixtures --regen`; `--size`/`--fps`
tune the video (1080p is heavy — try `--size 1280x720` for more bots at once).

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
