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

- **Video**: real footage, if you give it some. Put a few clips in a folder —
  people talking to camera looks the most convincing — and import them:

  ```bash
  node scripts/import-videos.mjs ~/Downloads/meeting-clips
  ```

  They become `clip-1` … `clip-5`, and bots cycle through them. Needs ffmpeg.
  Clips are converted to 1920x1080 MJPEG at 30 fps, which is what Chrome's fake
  camera accepts; raw Y4M at that size would be about 93 MB per second.
  Anything you do not supply falls back to a drawn clip: bright, detailed
  patterns built to make quality loss obvious on the receiving end.
- **Audio**: continuous natural speech, a different system voice and a different
  passage per bot, so a call sounds like a room of people rather than one clip
  playing five times.

Clips and run data live in `~/Library/Application Support/CallBots` on macOS
(`CALL_BOTS_HOME` overrides it).

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
