# Call Bots

*По-русски: [README.md](README.md)*

Put any number of bots into an Aloqa call from one computer. Each bot is a real
browser that opens the call's invite link, types a name, and publishes real
WebRTC audio and video. They join as anonymous guests, so there are no accounts
and nothing to provision — the invite link is the only input.

## One command

```bash
./run.sh --link "<invite-link>" --bots 10
```

That is the whole setup. It installs its own Node, its own Chromium and
everything else into `./.server`, then sends the bots in. Run it again and it
starts in about a second. Works on macOS and Ubuntu.

```bash
./run.sh --link "<link>" --bots 3 --share 1                 # one bot shares its screen
./run.sh --link "<link>" --bots 10 --camera off --mic off   # arrive muted and dark
./run.sh --link "<link>" --bots 5 --video-codec vp9         # prefer a camera send codec
./run.sh --ui                                               # a window instead of the terminal
./run.sh --check                                            # set up, send no bots
./run.sh --clean                                            # remove everything it installed
```

`--ui` opens a dashboard on `http://127.0.0.1:4610` with a card per bot: mute,
camera, screen share, send codecs, remove, and the same for all of them at
once; the header shows the computer's live CPU, RAM and network throughput,
so the headroom for more bots is always in view. It binds
to localhost, so on a server reach it through a tunnel:

```bash
ssh -L 4610:127.0.0.1:4610 <user>@<server>
```

## What a bot publishes

- **Camera** — footage of a person at a desk, 1920x1080 at 30fps. Five clips,
  one per bot, so a call looks like different people.
- **Microphone** — a recording of a real man talking, continuously. Five
  voices, one per bot.
- **Screen share** — a wildflower meadow at 1920x1080, captioned with the bot's
  name and a clock.

All of it ships with the app. To use your own, drop files in
`~/Library/Application Support/CallBots/fixtures` (macOS) — `screen.webm` for
the shared screen, or run `node scripts/import-videos.mjs <folder> --bundle` to
replace the camera clips. Sources and licences are in
[media/CREDITS.md](media/CREDITS.md).

## Good to know

- **How many.** `--check` reports what your machine can carry — about 6
  publishing bots on a 16 GB laptop, more with `--camera off --mic off`. Past
  that, CPU contention degrades the media itself.
- **Getting in.** On entry mode **Open** bots walk straight in. On **Wait for
  admission** they queue in the lobby and wait up to ten minutes for you.
- **Screen sharing** is `--share <n|all>` — that many bots start sharing once
  they are in. It needs Meeting settings → Screen share → **Allowed**. If it
  was previously *On request*, send the bots again: Aloqa does not lift that one
  for anyone already in the call.
- **Send codecs.** `--audio-codec`, `--video-codec` and `--screen-codec` choose
  what a bot *sends* (`opus`; `vp8`/`vp9`/`h264`/`av1`/`h265`).
  In the dashboard, camera and screenshare dropdowns sit on each bot's stream
  monitor and in the all-bots bar (audio is opus-only, so it has no picker) — switchable at any moment, mid-call included. A
  bot's own dropdowns list only what its call actually negotiates, so every
  choice offered is one that can land. A codec only ever changes through a
  negotiation the call takes part in — anything else would black the bot out
  for every other participant. On Aloqa the bot republishes its track the
  LiveKit way, so a switch lands in a second or two; other platforms
  renegotiate, and failing that the bot briefly rejoins. The stream rows show
  what was really negotiated. H264/H265 availability depends on the browser
  the bots run in.
- **A Mac app**, if you would rather not use a terminal: `npm run build:app`
  builds a versioned ZIP in `dist/` (Apple Silicon). Version `0.3.0` must be
  installed manually once and opened with right-click → Open because it is
  ad-hoc signed. After that the app checks every time it opens and once daily
  while it stays open; use **Call Bots → Check for Updates…** to check
  immediately.
- **Selector drift** after an Aloqa deploy is fixed in one file,
  `src/platforms/aloqa.mjs`. `npm run test:platforms` checks the adapter against
  a mock of that DOM.

## Releasing a Mac version

From a clean `main` branch, pass the new version to one command:

```bash
npm run release:mac -- 0.3.0
```

It runs the tests, builds and signs the ZIP and `appcast.xml`, then publishes
both as GitHub Release assets. Installed apps read the feed from the stable
`releases/latest/download/appcast.xml` URL.
