# Call Bots

*По-русски: [README.md](README.md)*

Put bots into Aloqa or Google Meet calls from one computer. Each bot is a real
browser that opens the call link and publishes real audio and video. Aloqa bots
join as anonymous guests, so there is nothing to provision. Google Meet is the
rare case: it needs one manually signed-in Google account per concurrent bot,
managed by the app, and it stays out of the dashboard until you paste a Meet
link.

## One command

```bash
./run.sh --link "<call-link>" --bots 10
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
so the headroom for more bots is always in view. Pin the bot you keep coming
back to and its card moves to a row of its own above every batch, so it is
never a scroll away. A bot's stream monitor opens with the path ICE settled
on — `direct · STUN · UDP`, or `via TURN relay` when the media is detouring
through a relay — with the candidate types and DTLS state on hover. It binds
to localhost, so on a server reach it through a tunnel:

```bash
ssh -L 4610:127.0.0.1:4610 <user>@<server>
```

## Google Meet

Meet is a rare guest here, so it stays out of sight: paste a
`https://meet.google.com/abc-defg-hij` link and one line appears under the link
field. With an Aloqa link, or none, the dashboard says nothing about Meet at all.

That line offers the two ways in. **Guests** is the default and needs nothing at
all: each bot opens the meeting, types its name and waits for you to admit it,
exactly as an Aloqa guest does. Terminal: that is what `join` already does.

The catch is Google's, not ours: **Meet refuses anonymous visitors for any
meeting created by a personal Google account** — no name field, just "You can't
join this video call", and that holds even while the host is sitting in the
call. Only a Workspace meeting can take guests, and only if its admin allows it.
For everything else, use accounts.

## Google Meet accounts

**Google accounts** is the other half of that switch, and the one that always
works. Each concurrent Meet bot needs its own Google account, and Google Chrome
must be installed. Terminal: `--as account`. **Manage → Add account** opens Chrome on an isolated Call Bots
profile — sign in there and the row confirms it while the window is still open;
close that window and the account turns Ready. **Check** reopens a saved profile
quietly and reports whether Google still accepts it, so a session that has
expired is found before a batch is, not halfway through one. **Remove** deletes
only that local session, never the Google account.

Bots use their Google display names, enter directly when permitted, or wait for
the host to admit them. Camera, microphone, participant checks, the RTC stream
monitor and the dark-camera watchdog all work the same as on Aloqa — a Meet bot
whose camera goes dark now gets healed like any other.

Three things stay off for Meet, each because Meet itself will not do them:
**screen sharing** (Meet is handed a live 1920x1080 track and then refuses to
start presenting), **send codecs** (Meet negotiates its own list and picks AV1
from it whatever the preference says), and **`--label`** (a Meet bot is named by
its Google account). The controls are hidden rather than left to fail, and the
checks behind them are in `src/platforms/meet.mjs`.

**"Call Bots was prevented from modifying apps on your Mac."** Dismiss it — Call
Bots never modifies an app, and nothing here needs that permission. It is Google
Chrome finishing its own update: macOS blames whichever app launched Chrome, and
for Meet that has to be this one, because the saved sign-in belongs to real
Chrome and not to the bundled Chromium. To stop it recurring, open Chrome by
itself once and let the update finish, or grant **App Management** to
*GoogleUpdater* — not to Call Bots.

**Meet must be in English.** Meet renders in the signed-in account's own Google
language, which overrides the language in the link, and the adapter reads
Meet's English controls. An account set to another language is reported as such
rather than timing out.

## What a bot publishes

- **Camera** — footage of a person at a desk, 1920x1080 at 30fps. Five clips,
  one per bot, so a call looks like different people.
- **Microphone** — a recording of a real man talking, continuously. Five
  voices, one per bot.
- **Screen share (Aloqa)** — a wildflower meadow at 1920x1080, captioned with
  the bot's name and a clock.

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
  admission** they queue in the lobby and wait up to ten minutes for you. Meet
  accounts likewise enter directly when allowed or wait for the host — and a
  Meet bot that is let straight in reports a failure in a minute rather than
  sitting out the ten-minute lobby budget that never applied to it.
- **Screen sharing** is `--share <n|all>` — that many bots start sharing once
  they are in. It needs Meeting settings → Screen share → **Allowed**. If it
  was previously *On request*, send the bots again: Aloqa does not lift that one
  for anyone already in the call.
- **Send codecs.** `--audio-codec`, `--video-codec` and `--screen-codec` choose
  what a bot *sends* (`opus`; `vp8`/`vp9`/`h264`/`av1`/`h265`). In the
  dashboard, camera and screenshare dropdowns sit on each bot's stream monitor
  and in the all-bots bar (audio is opus-only, so it has no picker) —
  switchable at any moment, mid-call included. To send bots in *on* a codec
  instead of switching them afterwards, the **Codecs** link beside the
  *Join with* label brings out the same two pickers next to the camera and
  microphone toggles — folded away by default, so the bar stays one row. They
  ride the next send and leave the bots already in the call alone. A codec that turns out to carry nothing — H265 stalls on
  some machines — is handed back to the call's own codec at the join, and the
  bot's card says so. An encoder can also wedge later, mid-call and on any
  codec; a camera that publishes nothing for twelve seconds is turned off
  and on, then rejoined on a fresh connection, and if neither works the card
  says the call cannot see that bot. A bot going dark is never silent about it: its own tile stays lit
  either way, because a self-view never reaches the network. A bot's own
  dropdowns list only what its call actually negotiates, so every choice
  offered is one that can land. A codec only ever changes through a
  negotiation the call takes part in — anything else would black the bot out
  for every other participant. On Aloqa the bot republishes its track the
  LiveKit way, so a switch lands in a second or two; other platforms
  renegotiate, and failing that the bot briefly rejoins. A switch leaves
  nothing behind it: the sender the old publication used is stopped rather
  than left to encode a second copy of the picture, so switching all day does
  not end with a bot publishing two ladders at twice the bitrate. And a
  switch made while the picture has sunk under CPU load puts the capture back
  to full size first — republishing as-is would fix the new track's ceiling
  at whatever frame it caught, with no way back up — so a bot switched at a
  bad moment still climbs to full HD. The stream rows show what was really
  negotiated. H264/H265 availability depends on the browser the bots run in.
- **A Mac app**, if you would rather not use a terminal: `npm run build:app`
  builds a versioned ZIP in `dist/` (Apple Silicon). Version `0.3.0` must be
  installed manually once and opened with right-click → Open because it is
  ad-hoc signed. After that the app checks every time it opens and once daily
  while it stays open; use **Call Bots → Check for Updates…** to check
  immediately.
- **Selector drift** is isolated in `src/platforms/aloqa.mjs` and
  `src/platforms/meet.mjs`. `npm run test:platforms` checks both adapters
  against mock pages; a real call remains the final acceptance check.

## Releasing a Mac version

From a clean `main` branch, pass the new version to one command:

```bash
npm run release:mac -- 0.3.0
```

It runs the tests, builds and signs the ZIP and `appcast.xml`, then publishes
both as GitHub Release assets. Installed apps read the feed from the stable
`releases/latest/download/appcast.xml` URL.
