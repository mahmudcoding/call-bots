import os from 'node:os'

// How many publishing browsers this machine can realistically carry.
// Each participant is a full Chrome encoding and decoding live video, so the
// ceiling is set by both memory and cores — whichever runs out first.
// Measured on a 16 GB / 12-core Mac: ~6 before the media itself degrades.
export const machineProfile = () => {
  const memGB = os.totalmem() / 1024 ** 3
  const cores = os.cpus().length || 4
  const byMemory = Math.floor(memGB / 2.5)
  const byCores = Math.floor(cores * 0.75)
  const recommendedMax = Math.max(2, Math.min(byMemory, byCores))
  return {
    memGB: Math.round(memGB),
    cores,
    recommendedMax,
    platform: `${os.platform()}/${os.arch()}`,
  }
}

export const concurrencyWarning = (count, profile = machineProfile()) => {
  if (count <= profile.recommendedMax) return null
  return (
    `${count} participants — above about ${profile.recommendedMax} publishing at once, ` +
    `CPU contention can degrade the media itself on this machine ` +
    `(${profile.memGB} GB RAM, ${profile.cores} cores).`
  )
}
