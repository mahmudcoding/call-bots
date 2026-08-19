// Builds dist/Aloqa Calls Sim.app — a double-click macOS app that runs the
// dashboard with its own bundled Node runtime. macOS-only build (uses sips,
// iconutil, codesign, ditto).
import { execFileSync } from 'node:child_process'
import {
  chmodSync, cpSync, createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const NODE_VERSION = '22.12.0'
const APP_NAME = 'Aloqa Calls Sim'
const BUNDLE_ID = 'com.aloqa.calls-sim'

if (process.platform !== 'darwin') {
  console.error('the .app can only be built on macOS')
  process.exit(1)
}

const { projectRoot } = await import('../src/config.mjs')
const { version } = (await import(`file://${projectRoot}/package.json`, { with: { type: 'json' } })).default

const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const dist = join(projectRoot, 'dist')
const appRoot = join(dist, `${APP_NAME}.app`)
const contents = join(appRoot, 'Contents')
const resources = join(contents, 'Resources')
const cacheDir = join(projectRoot, '.data', 'build-cache')

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' })
const step = (label) => console.log(`• ${label}`)

// --- 1. clean skeleton -------------------------------------------------------
step('creating bundle skeleton')
rmSync(appRoot, { recursive: true, force: true })
mkdirSync(join(contents, 'MacOS'), { recursive: true })
mkdirSync(join(resources, 'app'), { recursive: true })
mkdirSync(join(resources, 'node', 'bin'), { recursive: true })
mkdirSync(cacheDir, { recursive: true })

// --- 2. Info.plist + launcher ------------------------------------------------
writeFileSync(
  join(contents, 'Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`,
)

// LSUIElement: no Dock icon — the dashboard's Quit button is the way out, and
// relaunching the app while the server runs just reopens the browser tab.
writeFileSync(
  join(contents, 'MacOS', 'launcher'),
  `#!/bin/bash
set -euo pipefail
CONTENTS="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
APP="$CONTENTS/Resources/app"
NODE="$CONTENTS/Resources/node/bin/node"
export CALLS_SIM_HOME="$HOME/Library/Application Support/AloqaCallsSim"
mkdir -p "$CALLS_SIM_HOME"
PORT="\${CALLS_SIM_PORT:-4610}"
if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/api/state"; then
  open "http://127.0.0.1:$PORT"
  exit 0
fi
exec "$NODE" "$APP/src/cli.mjs" ui --port "$PORT" >>"$CALLS_SIM_HOME/server.log" 2>&1
`,
)
chmodSync(join(contents, 'MacOS', 'launcher'), 0o755)

// --- 3. app payload ----------------------------------------------------------
step('copying app payload')
cpSync(join(projectRoot, 'src'), join(resources, 'app', 'src'), { recursive: true })
cpSync(join(projectRoot, 'package.json'), join(resources, 'app', 'package.json'))
cpSync(join(projectRoot, 'users.example.yaml'), join(resources, 'app', 'users.example.yaml'))
cpSync(join(projectRoot, 'node_modules'), join(resources, 'app', 'node_modules'), {
  recursive: true,
  filter: (source) => !source.includes(`node_modules${'/'}.bin`),
})

// --- 4. bundled Node runtime -------------------------------------------------
const tarName = `node-v${NODE_VERSION}-darwin-${arch}.tar.gz`
const tarPath = join(cacheDir, tarName)
if (!existsSync(tarPath)) {
  step(`downloading Node v${NODE_VERSION} (${arch})`)
  const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${tarName}`)
  if (!response.ok) throw new Error(`node download failed: HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tarPath))
} else {
  step(`using cached Node v${NODE_VERSION} (${arch})`)
}
const extractDir = join(cacheDir, 'node-extract')
rmSync(extractDir, { recursive: true, force: true })
mkdirSync(extractDir, { recursive: true })
run('tar', ['-xzf', tarPath, '-C', extractDir, `node-v${NODE_VERSION}-darwin-${arch}/bin/node`])
cpSync(
  join(extractDir, `node-v${NODE_VERSION}-darwin-${arch}`, 'bin', 'node'),
  join(resources, 'node', 'bin', 'node'),
)
chmodSync(join(resources, 'node', 'bin', 'node'), 0o755)

// --- 5. icon (rendered with our own browser stack) ---------------------------
step('rendering icon')
const { chromium } = await import('playwright')
const { systemChromePath } = await import('../src/browser.mjs')
const browser = await chromium.launch({
  channel: systemChromePath() ? 'chrome' : undefined,
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } })
await page.setContent(`
  <body style="margin:0;background:transparent">
  <div style="width:1024px;height:1024px;border-radius:232px;
              background:linear-gradient(160deg,#1a2030,#0b0d12);
              display:grid;place-items:center;
              box-shadow:inset 0 0 0 10px rgba(255,255,255,.05)">
    <div style="width:600px;height:600px;display:grid;gap:30px;
                grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr">
      <div style="border-radius:60px;background:linear-gradient(150deg,#2f8fb0,#1f6f8b)"></div>
      <div style="border-radius:60px;background:linear-gradient(150deg,#b03868,#8b1f4f)"></div>
      <div style="border-radius:60px;background:linear-gradient(150deg,#54a33f,#3a7d2c)"></div>
      <div style="border-radius:60px;background:linear-gradient(150deg,#8a6cc4,#6b4fa0)"></div>
    </div>
  </div>`)
const iconPng = join(cacheDir, 'icon-1024.png')
await page.screenshot({ path: iconPng, omitBackground: true })
await browser.close()

const iconset = join(cacheDir, 'AppIcon.iconset')
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset)
for (const [size, name] of [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'], [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'], [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'], [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
]) {
  run('sips', ['-z', String(size), String(size), iconPng, '--out', join(iconset, name)])
}
run('iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'AppIcon.icns')])

// --- 6. sign (ad-hoc) + zip --------------------------------------------------
step('ad-hoc code signing')
run('codesign', ['--force', '--deep', '--sign', '-', appRoot])

step('zipping')
const zipPath = join(dist, `AloqaCallsSim-${version}-${arch}.zip`)
rmSync(zipPath, { force: true })
run('ditto', ['-c', '-k', '--keepParent', appRoot, zipPath])

const sizeMb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`
const { statSync } = await import('node:fs')
const du = execFileSync('du', ['-sk', appRoot]).toString().split('\t')[0]
console.log(`\nbuilt: ${appRoot} (${(Number(du) / 1024).toFixed(0)} MB)`)
console.log(`zip:   ${zipPath} (${sizeMb(statSync(zipPath).size)})`)
console.log('\nnote: ad-hoc signed. Recipients of the zip must right-click → Open on first launch')
console.log('(or: xattr -dr com.apple.quarantine "/Applications/Aloqa Calls Sim.app")')
