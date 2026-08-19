import aloqa from './aloqa.mjs'
import meet from './meet.mjs'

// Order matters: Aloqa runs on any origin and matches by path shape, so it goes
// last and acts as the catch-all. Platforms tied to one host come first.
export const PLATFORMS = [meet, aloqa]

export const platformById = (id) => PLATFORMS.find((platform) => platform.id === id) ?? null

// The link is the only input the app needs: it says which platform to drive,
// which origin to grant camera and microphone to, and where to send the bot.
export const resolveLink = (input) => {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('paste the call link')
  if (!/^https?:\/\//u.test(raw)) {
    throw new Error('that is not a full link — copy the link including https://')
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`not a valid link: ${raw.slice(0, 60)}`)
  }

  for (const platform of PLATFORMS) {
    const target = platform.parse(url)
    if (target) return { ...target, platform: platform.id, label: platform.label }
  }
  throw new Error(
    'that link is not one we recognise — paste a Google Meet link ' +
      '(meet.google.com/abc-defg-hij) or an Aloqa call invite (…/join/<token>)',
  )
}
