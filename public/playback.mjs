// Playback belongs to a film's address, including across reloads and browser navigation.
export function readPlayback(storage, id) {
  try {
    const value = JSON.parse(storage.getItem(`film-playback:${id}`))
    return Number.isFinite(value?.t) && value.t >= 0 ? value : null
  } catch { return null }
}

export function savePlayback(storage, id, player) {
  try { storage.setItem(`film-playback:${id}`, JSON.stringify({ t: player.t })) } catch {}
}

export function initialPlayback({ restore, ready, finished, saved, duration, preludeAt = 0 }) {
  const returning = restore && ready
  return {
    name: returning && finished ? 'replay' : 'live',
    at: returning ? Math.min(saved?.t ?? 0, duration) : preludeAt,
    play: !returning,
  }
}
