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
3. Bots appear as cards with a live view of what each one sees. Mute, toggle
   cameras, share a screen, or remove a bot — individually or for all of them.
   **Add bots** puts more into the same call; **Stop** ends the session and
   closes every browser.

A bot has no desktop, so sharing a screen shares a page of its own: a
wildflower meadow filling the frame, with a small caption naming the bot and a clock so
you can tell whose screen it is and that the picture is live. The footage is captured at 1920x1080 — the resolution comes from the
browser context's viewport, not from the page or the window — so what leaves
the bot is genuinely full HD, and what each participant receives after that is
LiveKit's adaptation.

Drop your own `screen.webm` in the fixtures folder to share something else; it
wins over the one that ships, the same way imported camera clips do.

The call has to permit it. In Aloqa that is **Meeting settings › Screen share ›
Allowed**; while it is blocked the button renders disabled and the bot reports
`blocked` rather than pretending to share.

Terminal equivalent:

```bash
node src/cli.mjs join "<invite-link>" --guests 4
```

## What each bot publishes

- **Video**: five clips of different people at a desk looking into the camera,
  1920x1080 at 30 fps. They ship inside the app, so a fresh download joins a
  call with real faces — nothing to import, no network. Bots cycle through the
  five.
- **Audio**: real recordings of five different men, taken from the AMI Meeting
  Corpus — people in actual meetings, one per bot, silence between their turns
  removed so each plays as continuous speech. Not synthesised. See
  `media/CREDITS.md` for sources and licence (CC BY 4.0).

`npm run voices` regenerates the set from system text-to-speech instead, which
is the fallback when there are no recordings to hand. It overwrites the real
ones, so only run it if that is what you want.

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
./run.sh --link "<invite-link>" --bots 10 --camera off --mic off
./run.sh --link "<invite-link>" --ui                # dashboard instead
./run.sh --clean                                    # remove everything it made
```

Everything it installs — its own Node, its own Chromium, its own npm cache and
run data — lives in `./.server`, about 1.2 GB. Nothing is written outside that
directory and nothing is installed globally, so `--clean` removes all of it.

The single exception is Chromium's shared libraries, which only apt can
provide. Those are installed system-wide, and only when Chromium actually fails
to start — the script tries first and does nothing if the machine already has
what it needs.

That apt step is the one thing that could affect the rest of the server, so it
runs under a config that forbids apt from removing or upgrading anything. If
the libraries would conflict with something already installed, the install is
refused and nothing changes, rather than apt quietly removing a package another
service depends on. `--no-deps` skips the step entirely.

If Chromium still will not start after that, the distribution is likely older
than the browser expects, which apt cannot fix — run it in a container instead.

Two things matter on a server. Use entry mode **Open**, because nobody is there
to admit bots from a lobby. And the dashboard binds to localhost, so reach it
over a tunnel rather than opening a port:

```bash
ssh -L 4610:127.0.0.1:4610 <user>@<server>
```

Verified end to end on a bare Ubuntu 24.04 image with no curl, no Node and no
Chromium: one command installs everything and sends the bot. A second run
starts in about a second. Sizing is per machine — `--check` reports what
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
