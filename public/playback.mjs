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

// What is being done now, from the stages in so far, until the film starts (they come in a different order on a fresh
// photo and on a picked project). A written problem is read and solved: nothing is cut out of its photo or drawn.
export function makingStatus(stages) {
  const repairing = [...stages].some((n) => /^script: (repair|patch) /.test(n))
  if (stages.has('perception: problem')) {
    if (stages.has('layout')) return 'Starting the film'
    if (!stages.has('script: done')) return repairing ? 'A step did not check out: fixing the solution' : 'Working out the solution'
    return 'Laying out the film'
  }
  if (stages.has('layout')) return 'Finishing the object drawings'
  if (!stages.has('script: done')) return !stages.has('script: object list') ? 'Reading your photo'
    : repairing ? 'A part did not fit: fixing the plan' : 'Writing the steps'
  return stages.has('SAM: cut-outs') ? 'Laying out the film' : 'Cutting each thing out of the photo'
}
