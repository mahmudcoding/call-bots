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

## Sharing the app

`npm run build:app` also writes `dist/call_bots.zip`, which is
everything a recipient needs — Node, the footage, the voices. They do not need
Node, ffmpeg, or this repository.

- **Apple Silicon only.** The bundled Node and the native shell are built for
  the machine that ran the build. An Intel Mac needs its own x64 build.
- **macOS 12 or newer.**
- **First launch:** the app is ad-hoc signed, so macOS blocks a double-click.
  Right-click the app and choose Open, or run
  `xattr -dr com.apple.quarantine "/Applications/Call Bots.app"`.
- **First run downloads Chromium** (about 150 MB) and shows progress in the
  window. After that it works offline.
- How many bots a machine can carry is measured from its own RAM and cores.

## Using it

1. Start a call in Aloqa and copy its **invite link** (the "Add to call" panel).
2. Paste it, choose how many bots, and whether they arrive with **Camera** and
   **Mic** on, then press **Send bots**. Those toggles set the state a bot
   joins in; every bot still carries its clip and voice, so one switched on
   later publishes real footage rather than an empty tile.
3. Guests appear as cards with a live view of what each one sees. Mute, toggle
   cameras, share a screen, or remove a guest — individually or for all of them.
   **Add guests** puts more into the same call; **Stop** ends the session and
   closes every browser.

Terminal equivalent:

```bash
node src/cli.mjs join "<invite-link>" --guests 4
```

## What each bot publishes

- **Video**: five clips of different people at a desk looking into the camera,
  1920x1080 at 30 fps. They ship inside the app, so a fresh download joins a
  call with real faces — nothing to import, no network. Bots cycle through the
  five.
- **Audio**: continuous natural speech, a different voice and a different
  passage per bot, so a call sounds like a room of people rather than one clip
  playing five times.

To use your own footage instead, put a few videos in a folder — people talking
to camera looks the most convincing — and import them (needs ffmpeg):

```bash
node scripts/import-videos.mjs ~/Downloads/meeting-clips            # this machine
node scripts/import-videos.mjs ~/Downloads/meeting-clips --bundle   # ship with the app
```

They become `clip-1` … `clip-5`, and each clip's own soundtrack becomes that
bot's voice. Clips are converted to MJPEG, which is what Chrome's fake camera
accepts; raw Y4M at 1080p30 would be about 93 MB per second. Imports on this
machine win over the shipped footage; a clip with no source at all falls back to
a drawn one — bright, detailed patterns built to make quality loss obvious on
the receiving end.

Shipped footage lives in `media/` (copied into the `.app` at build time).
Imported clips and run data live in `~/Library/Application Support/CallBots` on
macOS (`CALL_BOTS_HOME` overrides it).

## Running it on a server

`run.sh` sets up an Ubuntu server from nothing and sends the bots in:

```bash
./run.sh --install-deps --check                     # first time, once
./run.sh --link "<invite-link>" --bots 10 --camera off --mic off
./run.sh --link "<invite-link>" --ui                # dashboard instead
./run.sh --clean                                    # remove everything it made
```

Everything it installs — its own Node, its own Chromium, its own npm cache and
run data — lives in `./.server`, about 1.2 GB. Nothing is written outside that
directory and nothing is installed globally, so `--clean` removes all of it.

The single exception is Chromium's shared libraries, which only apt can
provide. The script never installs them silently: it checks, tells you if any
are missing, and installs them only when you pass `--install-deps`.

Two things matter on a server. Use entry mode **Open**, because nobody is there
to admit bots from a lobby. And the dashboard binds to localhost, so reach it
over a tunnel rather than opening a port:

```bash
ssh -L 4610:127.0.0.1:4610 <user>@<server>
```

Verified end to end on Ubuntu 24.04: setup from a bare image, browser starts,
and a bot reaches the product. Sizing is per machine — `--check` reports what
that one can carry.

## Notes

- The realistic ceiling is what `doctor` reports for your machine (measured from
  RAM and cores, about 6 on a 16 GB laptop). Beyond it, CPU contention degrades
  the media itself.
- The call must admit guests without approval (entry mode **Open**); otherwise
  the app reports that the host needs to admit them.
- Guests are anonymous, so each browser is always a fresh context — a signed-in
  cookie would make the invite page join as that account instead.
- Aloqa lives in `src/platforms/aloqa.mjs`, holding its selectors, join
  sequence, device toggles and participant grid. Selector drift after a deploy
  is fixed there and nowhere else. Another platform would be another file listed
  in `src/platforms/index.mjs` — though a platform that requires every
  participant to be signed in cannot be driven this way at all.
- `npm run test:platforms` drives every adapter against a page mimicking that
  platform's DOM. It catches a broken adapter, not a redesigned product.
- `npm run clean` kills leftover guest browsers after a hard kill.
