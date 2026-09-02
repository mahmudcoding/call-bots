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

**Attaching a debugger is what gets blocked.** Not headless, not the profile,
not the browser build — the DevTools/CDP connection itself. Proven back to back
in the same minute, on the same live meeting, with the same Chrome launch:

| how the page was driven | result |
| --- | --- |
| plain incognito, read through Chrome's AppleScript `execute javascript` | `inputs: ["Your name"]`, "This call is open to anyone" |
| same launch **plus** `--remote-debugging-port` and `connectOverCDP` | "You can't join this video call" |

A signed-in bot is unaffected and can stay headless on Playwright. Google
tolerates automation that has an identity; it does not tolerate anonymous
automation.

Headless *also* fails, and was the first thing found — but it is downstream of
this. Do not spend time on it again.

### What was ruled out

Each changed on its own against a live meeting, everything else held. None of
them changed the answer:

- bundled Chromium vs real Google Chrome
- `navigator.webdriver` true vs false (spoofed via an init script)
- `--enable-automation` present vs removed
- a fresh profile, a copy of a signed-in profile, and a fresh profile seeded
  with the real Chrome's `Local State`
- an incognito window opened inside a signed-in profile
- the meeting host present in the call vs absent
- `?hl=en&authuser=0`, `?hl=en`, and a bare URL
- the `--use-file-for-fake-*-capture` flags present vs absent
- Chrome loading the URL from its command line vs a scripted navigation
- polling the page every 500 ms from the first moment vs waiting
- connecting 1.2 s after Chrome starts vs 9 s
- `--remote-debugging-port=0` vs a fixed port

Whether a meeting accepts anonymous visitors at all is a property of the
meeting. "This call is open to anyone" is Meet saying it does. **Always re-run
the no-CDP control immediately before and after any guest experiment** — a
result without a passing control either side of it means nothing. An hour was
lost to a meeting that quietly stopped taking guests mid-investigation and then
started again.

## How to drive a guest: like a person, not a debugger

Open the window the way a user does, and script it through Chrome's AppleScript
interface. **No `--remote-debugging-port`, no Playwright, no CDP.**

```bash
open -na "Google Chrome" --args --incognito --lang=en-US "https://meet.google.com/<code>?hl=en"
```

Then read and act with `execute javascript` on the tab. This is a full working
join, verified end to end — it typed a name, clicked through, and landed in the
call:

```applescript
tell application "Google Chrome"
  repeat with w in windows
    repeat with t in tabs of w
      if (URL of t contains "<code>") then
        return execute t javascript "…returns JSON…"
      end if
    end repeat
  end repeat
end tell
```

Filling Meet's name field needs the React-safe form, not `input.value =`:

```js
var set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
set.call(input, name)
input.dispatchEvent(new Event('input', { bubbles: true }))
input.dispatchEvent(new Event('change', { bubbles: true }))
```

Clicking is plain `element.click()` on the button whose `aria-label` or
`textContent` matches.

Requirements and consequences:

- Chrome needs **View → Developer → Allow JavaScript from Apple Events** on.
- macOS only. Guests cannot work this way on Linux.
- The window is real and visible. N guests means N windows on screen.
- No Playwright page object, so no `page.screenshot` for card thumbnails and no
  `addInitScript`. The RTC monitor can still go in, because `installMonitor`
  only needs an evaluate — `execute javascript` can carry it.
- **Pass `--lang=en-US` at launch.** A signed-out incognito window renders Meet
  in Chrome's own UI language regardless of `?hl=en`; one opened without it came
  up in Russian, where every English selector in the adapter misses. The in-call
  toolbar read `Выключить микрофон` / `Участники1` / `Показать экран`, and the
  leave button was `Выйти из звонка`, not `Leave call`.

### The two constraints that shape the driver

Both measured, both non-obvious:

1. **Apple Events reach only one Chrome process.** Launch a second Chrome with
   its own `--user-data-dir` and `tell application "Google Chrome"` starts
   answering for exactly one of them — the other becomes invisible to scripting.
   Which one wins is not stable: right after launching the bot Chrome the events
   went to it, and minutes later they went back to the user's. So a guest driver
   cannot just spawn its own Chrome and expect to script it.

   The deterministic fix is a **separate application bundle**: copy `Chrome.app`
   and give the copy its own `CFBundleIdentifier` and `CFBundleName`, then
   address that name from AppleScript. It never collides with the user's Chrome.
   A ~300 MB one-time copy, cached in the app's data directory.

2. **One process means one set of fake-capture flags.** `--use-file-for-fake-*`
   is process-wide, so every guest sharing a Chrome shares a camera clip and a
   voice. Aloqa bots and Meet account bots still get one apiece — only guests
   are alike. The alternative is an in-page `getUserMedia` override, which needs
   document-start injection that AppleScript cannot do.

Note that `open -na "Google Chrome" --args --incognito <url>` does **not** start
a process — it adds a tab to the existing incognito window, and the `--args` are
ignored. Only spawning the binary directly makes a new process.

Separate incognito windows in one process all share one incognito profile, and
Meet still counts each as its own guest — three hand-opened windows joined one
meeting as three separate participants.

### Where this is up to

`src/browser.mjs` currently launches guests with `--remote-debugging-port` and
`connectOverCDP`, which is the thing that gets refused. That needs replacing
with the AppleScript driver above. Everything else about the guest path —
mode plumbing, the guest/account switch, the `--as` flag, the refusal messages —
is already in place and tested.

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
