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

### The working recipe, verified end to end

Meet showed `inputs: ["Your name"]` — the guest name field — through every step
below, with no debugger anywhere near it.

**1. A separate Chrome application bundle.** Apple Events reach only ONE process
per bundle id: start a second Chrome and `tell application "Google Chrome"`
answers for exactly one of them, and which one is not stable. A copy with its
own identity is addressed unambiguously and never collides with the user's
browser.

```bash
ditto "/Applications/Google Chrome.app" "$BUNDLE"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.aloqa.call-bots.browser" "$BUNDLE/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName CallBotsBrowser" "$BUNDLE/Contents/Info.plist"
xattr -cr "$BUNDLE"          # or codesign fails: "resource fork ... not allowed"
codesign --force --sign - "$BUNDLE"
```

~300 MB, one time, cached. Then address it as
`tell application id "com.aloqa.call-bots.browser"`.

**2. Seed the profile before first launch**, or `execute javascript` refuses
with *"Executing JavaScript through AppleScript is turned off"*. It is a
per-profile preference and there is no command-line flag for it:

```bash
mkdir -p "$DIR/Default"
echo '{"browser":{"allow_javascript_apple_events":true}}' > "$DIR/Default/Preferences"
```

**3. Launch it.** `--use-mock-keychain --password-store=basic` are not optional:
without them macOS asks for the login password to let this re-signed copy read
the real Chrome's "Chrome Safe Storage" keychain item. A throwaway incognito
profile has no use for it, and granting it would hand a re-signed Chrome copy
the real one's cookie key.

```
--user-data-dir=<temp>  --incognito  --lang=en-US
--no-first-run  --no-default-browser-check
--use-mock-keychain  --password-store=basic
--use-fake-device-for-media-stream
--use-file-for-fake-video-capture=<clip>  --use-file-for-fake-audio-capture=<voice>
```

**No `--remote-debugging-port`.** That is the whole point.

**4. Drive it with single-line JavaScript.** AppleScript string literals cannot
span lines, and a multi-line script comes back as `missing value` rather than an
error, which is a confusing half hour if you have not seen it before.

Filling Meet's name field needs the React-safe form, not `input.value =`:

```js
var set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
set.call(input, name); input.dispatchEvent(new Event('input', { bubbles: true }))
```

Clicking is plain `element.click()`.

### What this costs

- **macOS only.** Guests cannot work this way on Linux.
- **One Chrome process for all guests**, because of the Apple Events limit — and
  `--use-file-for-fake-*` is process-wide, so every guest in a run shares one
  camera clip and one voice. Aloqa bots and Meet account bots still get one
  apiece. One incognito window per guest; Meet counts each as its own
  participant (three hand-opened windows joined one meeting as three guests).
- **Visible windows**, N of them.
- **Permission prompts the first time.** One Automation prompt — the app asking
  to control the *Call Bots browser* — because driving Chrome without a debugger
  *is* Apple Events. It is sent deliberately as the first event after the
  browser comes up, before any guest window exists, with two minutes for a
  person to answer it. And one Screen Recording prompt, for the card thumbnails
  (a `screencapture` of the window). Grants are per calling app: the terminal
  has them, the packaged `Call Bots.app` gets its own. **Never gate anything on
  System Events**: an earlier build checked liveness through it, the packaged
  app had no grant, macOS put up a dialog, and every Apple Event sat behind it
  until its timeout — a guest was left on Meet's name screen, untouched, while
  the same code ran clean from a shell. Liveness now comes from
  `lsappinfo find bundleid=…`, which is LaunchServices' own answer and needs no
  permission. Check grants with: `sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db
  "select client, indirect_object_identifier, auth_value from access where
  service='kTCCServiceAppleEvents'"`.
- **No Playwright page**, so no `addInitScript`. The card thumbnail is drawn
  in-page: the largest playing `<video>` (the bot's own tile) onto a canvas,
  returned as a JPEG data URL — no Screen Recording permission, and it shows
  exactly what the bot publishes. A `screencapture` of the window's rectangle
  is only the fallback. Nothing injected into a Meet page can see its peer connections —
  Meet takes `RTCPeerConnection` into a module closure while its bundle parses,
  and an injection during the load still loses the race — and `--load-extension`
  is dead in branded Chrome 152 (`chrome://extensions` stays empty, silently).
  **Stream stats come from `chrome://webrtc-internals` instead**, kept open in
  one extra window of the shared browser: it sees every connection in the
  process, Chrome lets AppleScript run JavaScript on it, and it renders live
  tables with ids `<rid>-<lid>-table-<statId>-<field>` (`bytesSent`, `kind`,
  `currentRoundTripTime`, `mediaSourceId`…). Each guest's page URL carries
  `#cb-<slug>`, which Meet ignores and the `.tab-head` prints, so a guest's
  own connections can be told from the others'.

Note `open -na "Google Chrome" --args ...` does **not** start a process — it
adds a tab to the existing incognito window and drops the `--args`. Only
spawning the binary directly makes a new process.

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
