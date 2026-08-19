# aloqa-calls-sim

Simulate **N real users in an Aloqa staging call** from one computer. Each
simulated user is a separate Chrome process signed in as a real staging
account, joining the call through the real UI and publishing **real WebRTC
audio+video** decoded from synthetic capture files. At the product / LiveKit /
server level they are indistinguishable from N people on N computers — the
only differences are the shared IP address and shared CPU.

Fully deterministic: fixed selectors, explicit waits, no AI anywhere.

## macOS app (zero-terminal option)

`npm run build:app` produces `dist/Aloqa Calls Sim.app` (plus a shareable
zip): a real windowed Mac app — native WKWebView shell around the dashboard
with a bundled Node runtime. No Node, npm, terminal, or browser tab needed on
the target Mac. Notes:

- The app owns the server: launching opens the window, quitting (⌘Q or the
  dashboard's Quit button) leaves any call and shuts everything down. If a
  dashboard server is already running (e.g. `npm start`), the app attaches to
  it instead of starting a second one.
- Config and state live in `~/Library/Application Support/AloqaCallsSim/`;
  the first launch creates `users.yaml` there (the dashboard's "Reveal file"
  button opens it in Finder). Logs: `server.log` in the same folder.
- Links that leave the dashboard (e.g. "Open call") open in your default
  browser, so you join the call as yourself.
- If the machine has no Chrome, the app downloads Chromium automatically on
  first launch (progress shows in the activity log).
- Building needs Xcode Command Line Tools (`swiftc`).
- The app is ad-hoc signed: when the **zip** is downloaded on another Mac,
  first launch needs right-click → Open (Gatekeeper), or
  `xattr -dr com.apple.quarantine "/Applications/Aloqa Calls Sim.app"`.
- The build is per-architecture (Apple Silicon vs Intel) — build on the kind
  of Mac you're targeting.

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

- paste one link — either the **call URL** from your address bar or the call's
  **guest invite link** — pick how many users (type a number, or filter and
  select), set a guest count, and launch;
- **Guests** — anonymous participants with no accounts, set before launch or
  added live from the session view. They need the guest invite link, since only
  a call's host can read one from the API;
- **Workspace setup** (folded away in the footer — it is a one-time job) —
  paste a workspace invite link and the app signs every selected user in and
  accepts it over plain HTTP, no browsers: 100 users in about 80 seconds. The
  joined workspace is saved back to the config;
- one card per simulated participant with a **live thumbnail of what that
  browser actually sees**, state pill, and one-click mic / camera / screen
  share / screenshot / leave / rejoin;
- "all users" bar for bulk mute/camera actions, verified remote-playing count,
  server participant count, call URL copy/open;
- live activity log, and a Stop button that tears everything down cleanly.

### CLI

```bash
node src/cli.mjs join "https://airion-cargo.store/w/<WS>/call/<CALL>" --users 4
node src/cli.mjs create --users 4 --guests 3
node src/cli.mjs join-workspace "<workspace-invite-link>"
```

Both end in an interactive console: `status`, `mute <n|all>`, `unmute`,
`cam <n|all> on|off`, `share <n> [stop]`, `guests <n>`, `leave <n>`,
`rejoin <n>`, `shot [n]`, `quit`. `Ctrl-C` tears down cleanly; `npm run clean`
removes leftover browser processes after a hard kill (works on Windows too, via
a process-marker sweep).

### Provisioning accounts

`scripts/provision-fleet.mjs` creates the dedicated accounts this tool drives:
it registers `user1@aloqa.calls` … `userN@aloqa.calls` (names `Call User N`,
shared password `password`) through the product's own registration endpoint,
marks them email-verified with a single exact-email SQL statement, checks every
login, and writes `users.yaml`. It needs a gitignored `provision.env` with the
staging Postgres credentials. It is idempotent — re-running skips accounts that
already exist.

```bash
node scripts/provision-fleet.mjs --count 100
```

Accounts start with no workspace: use the dashboard's **Workspace panel** (or
`join-workspace`) to put them wherever you need them.

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

## What each simulated participant publishes

- **Video**: one shared **1920×1080** clip, rendered in pure Node — an animated
  cartoon caller who nods, blinks and talks, over a drifting background, with
  rotating video-call punchlines ("YOU'RE ON MUTE", "MY CAT IS ON THE
  KEYBOARD"), a LIVE badge and a frame counter so a frozen tile is obvious. It
  renders in about two seconds and every participant reuses it.
- **Audio**: per participant, so a roster sounds like a real (bad) meeting —
  each one gets a different system voice and a different line, placed in its
  own slot of a looping cycle so the **active speaker rotates**.

Regenerate with `node src/cli.mjs fixtures --regen`; `--size`/`--fps` tune the
video (1080p is heavier on CPU — drop to `--size 1280x720` if you want more
concurrent participants).

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
