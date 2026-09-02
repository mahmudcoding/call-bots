# Call Bots

Bots that join Aloqa and Google Meet calls from one machine. Each bot is a real
browser publishing real WebRTC media from fake capture files.

Everything below about Google Meet was measured against live Meet on
2026-09-02, not inferred. Re-measure before trusting any of it again — Google
changes this without notice, and none of it is documented by them.

## Why Google Meet refuses a guest bot

A Meet bot joins one of two ways. With a saved Chrome profile it joins as that
Google account. Without one it joins anonymously — types a name, asks to be let
in. The anonymous path is the one with a trap in it.

**The gate is headless.** Google refuses anonymous Meet joins from a headless
browser. The page comes back:

> You can't join this video call

with no name field at all — on the very same meeting where a hand-opened
incognito window gets:

> This call is open to anyone · What's your name?

A signed-in bot is unaffected and can stay headless. Google tolerates
automation that has an identity; it does not tolerate anonymous automation.

### What was ruled out

Each of these was changed on its own against one live meeting, everything else
held. None of them changed the answer — headless was still refused, headed
still got in:

- bundled Chromium vs real Google Chrome
- `navigator.webdriver` true vs false (spoofed via an init script)
- `--enable-automation` present vs removed
- a fresh profile, a copy of a signed-in profile, and a fresh profile seeded
  with the real Chrome's `Local State`
- an incognito window opened inside a signed-in profile
- the meeting host present in the call vs absent
- `?hl=en&authuser=0`, `?hl=en`, and a bare URL
- the `--use-file-for-fake-*-capture` flags present vs absent
- Chrome loading the URL from its command line vs Playwright's `page.goto`
- polling `page.evaluate` every 500 ms from the first moment vs waiting
- connecting 1.2 s after Chrome starts vs 9 s

Whether a meeting accepts anonymous visitors at all is a property of the
meeting, not of the browser. "This call is open to anyone" is Meet saying it
does.

## How to run it so a guest gets in

Do not use Playwright's launcher. Start Chrome the way a person does and attach
afterwards. This is the sequence that works, reproduced repeatedly:

```js
const child = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--user-data-dir=${tempDir}`,           // fresh, throwaway
  '--incognito',
  '--remote-debugging-port=0',            // Chrome writes its choice to DevToolsActivePort
  '--no-first-run', '--no-default-browser-check',
  '--lang=en-US', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-video-capture=${clip}`,
  `--use-file-for-fake-audio-capture=${voice}`,
  'about:blank',
], { stdio: 'ignore', detached: true })          // NO --headless

const port = Number(readFileSync(`${tempDir}/DevToolsActivePort`, 'utf8').split('\n')[0])
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const context = browser.contexts()[0]
```

Then leave the window alone. **No `grantPermissions`, no `addInitScript`** — the
instrumentation is what Meet can see. That means a guest bot has no codec shim
and no capture shim, so it gets no codec control and no synthetic screen share;
Meet honours neither anyway (see below).

The camera prompt is answered in the page instead: Meet asks *"Do you want
people to see and hear you in the meeting?"* and the adapter clicks **Use
microphone and camera**. It must never click *Continue without microphone and
camera* — that joins publishing nothing, which is the exact failure this app
exists to make visible.

`browser.close()` only drops the CDP connection. The spawned process has to be
killed and its temp profile removed.

### Still broken

The app's own guest path is still refused where a standalone script running
this same sequence gets in. The difference has not been found. Untested so far:
`--remote-debugging-port=0` (app) vs a fixed port (working reproduction).

`CALL_BOTS_DEBUG_MEET=1` prints the stage the adapter classifies each tick,
which is the fastest way to see where a join actually dies.

## Other Meet facts worth not rediscovering

- **Presenting does not work.** `getDisplayMedia` hands Meet a live 1920x1080
  track and Meet's own bundle throws `DisconnectedError` and never starts.
  Reproduced on two meetings, and identically with the codec shim disabled.
- **Send codecs do not work.** Meet negotiates its own list and picks AV1 from
  it whatever the preference says — a runtime switch to vp9 and a launch-time
  h264 both left AV1 on the wire.
- **The stream monitor only works because of a bridge.** Meet keeps its
  `RTCPeerConnection`s in module closures, out of reach of the monitor's scan
  from `window`; it reported "no connection" on a live call. `src/codec-shim.js`
  publishes its registry as `window.__botPeerConnections__` to fix that, which
  is why the codec shim stays installed for account bots even though codec
  *control* is off. Guests have no shim and so no monitor.
- **Today's self tile has no self marker** — no `data-self-name`, no
  `aria-label`, no "you". Matching *sent* tracks does not identify it either,
  because Meet's effects pipeline publishes a different track than the self view
  renders. Remote tiles are the ones playing a `getReceivers()` track.
- **Meet renders in the account's language**, which overrides `hl` in the link.
  The adapter reads English control labels, so a non-English account fails.
- **Chrome holds a profile with a `SingletonLock` symlink** pointing at
  `<hostname>-<pid>`. That target is not a real path, so `existsSync()` follows
  it, finds nothing and reports no lock — it has to be read with `readlink`.
- **"Call Bots was prevented from modifying apps on your Mac"** is Chrome
  finishing its own update, attributed to whatever launched Chrome. Call Bots
  needs no such permission; deny it.

To get a meeting code for testing, open `meet.google.com` in a saved profile,
click `New meeting` (a button), then `Create a meeting for later` (a
**menuitem**, not a button), and read the code out of `document.body.innerText`.

## Tests

No framework. Each script collects `check(name, pass, detail)` and exits 1 on
any failure.

```bash
npm run test:platforms && npm run test:meet-profiles && npm run test:cli \
  && npm run test:guest && npm run test:ui && npm run test:stop
```

`test:platforms` drives each adapter against mock pages; `test:ui` drives the
real `src/ui.html` with the server stubbed at the network seam. A real call
remains the final acceptance check — every Meet finding above came from one.
