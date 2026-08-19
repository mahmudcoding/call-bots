# aloqa-calls-sim

Simulate **N real users in an Aloqa staging call** from one computer. Each
simulated user is a separate Chrome process signed in as a real staging
account, joining the call through the real UI and publishing **real WebRTC
audio+video** decoded from synthetic capture files. At the product / LiveKit /
server level they are indistinguishable from N people on N computers — the
only differences are the shared IP address and shared CPU.

Fully deterministic: fixed selectors, explicit waits, no AI anywhere.

## Install (any computer)

The only hard requirement is **Node.js 20+**. macOS, Windows, and Linux all
work; Google Chrome is used when present, otherwise a Chromium is downloaded
automatically on install.

```bash
git clone <this-repo>
cd aloqa-calls-sim
npm install        # zero-download when you already have Chrome
npm run setup      # creates users.yaml + checks browser/speech/config/staging
```

Edit `users.yaml` with real staging accounts (they must be members of the
call's workspace, 2FA off), then:

```bash
npm start          # opens the dashboard at http://127.0.0.1:4610
```

`npm run doctor` re-checks the machine any time. No ffmpeg, no pnpm, no other
system dependencies: video fixtures are rendered in pure Node, audio uses the
platform's text-to-speech (`say` on macOS, System.Speech on Windows,
`espeak`/`espeak-ng` on Linux) and falls back to distinct tone melodies when
none exists.

## Usage

### Web dashboard (recommended)

`npm start` (or `node src/cli.mjs ui [--port 4610] [--no-open]`) opens a
control room for the whole session:

- pick users (color-coded to match their published video), join an existing
  call by URL or create a fresh Open call, with headed / no-video / no-audio
  toggles;
- one card per simulated user with a **live thumbnail of what that user's
  browser actually sees**, state pill, and one-click mic / camera / screen
  share / screenshot / leave / rejoin;
- "all users" bar for bulk mute/camera actions, verified remote-playing count,
  server participant count, call URL copy/open;
- live activity log, and a Stop button that tears everything down cleanly.

### CLI

```bash
node src/cli.mjs join "https://airion-cargo.store/w/<WS>/call/<CALL>" --users 4
node src/cli.mjs create --users 4
```

Both end in an interactive console: `status`, `mute <n|all>`, `unmute`,
`cam <n|all> on|off`, `share <n> [stop]`, `leave <n>`, `rejoin <n>`,
`shot [n]`, `quit`. `Ctrl-C` tears down cleanly; `npm run clean` removes
leftover browser processes after a hard kill (works on Windows too, via a
process-marker sweep).

### Other commands and flags

```
calls-sim fixtures [--regen] [--size WxH] [--fps N]   regenerate per-user media
calls-sim doctor                                       machine health check
calls-sim clean                                        kill leftover processes
--users N | --only Alice,Bob    which config users to run
--headed                        show browser windows (default headless)
--no-video / --no-audio         join with camera / mic off
--browser chrome|chromium       force an engine (default: auto-detect)
--config <path>                 alternate users.yaml
--ws <id>                       workspace for create (default from users.yaml)
```

## What each simulated user publishes

- **Video**: looping y4m rendered in pure Node — the user's name, a frame
  counter, and a sweeping bar on a unique background color (a frozen tile is
  obvious at a glance).
- **Audio**: a looping 48 kHz WAV where each user speaks a synthesized phrase
  in their own time slot of a shared cycle, so the **active speaker rotates**
  through the roster (approximately — browser start times drift).

## Limits and behavior notes

- **~4–6 concurrent publishing users** is the realistic ceiling on a 16 GB
  machine; beyond that CPU contention degrades the media itself. The tool
  warns above 6.
- The call must be joinable without admission (**entry mode "Open"**). Sims
  stuck at "waiting for host approval" fail with an actionable message.
  Password-protected calls are rejected with a clear error.
- Sessions are cached in `.data/state/` — repeat runs skip the login form.
- Sim browsers run with `--mute-audio`: they publish audio but never play the
  call through your speakers.
- Screen share works headless via pre-armed tab capture. Rooms restrict who
  may share: the call's host (user 1 in `create` mode) shares directly; a
  regular member's `share` becomes a host-approval request — the tool reports
  `requested`; approve it in the host UI and share again.
- One user (the first in-call) acts as *verifier*: reports how many remote
  tiles its browser actually renders plus the server-side participant count —
  proof beyond button states.
- Selector drift after a frontend deploy: every selector lives in
  `src/selectors.mjs`.
- Verified end-to-end on macOS against staging (multi-user calls, controls,
  screen share, teardown). The Windows/Linux paths (TTS, process sweep,
  browser detection) follow the same structure but have not run on a real
  Windows/Linux box yet — `npm run doctor` is the first thing to run there.
