// Track the transfer separately from the server starting the manual.
export function uploadPhoto(body, onUploaded) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', '/api/films')
    request.upload.onload = onUploaded
    request.onload = () => {
      try {
        const answer = JSON.parse(request.responseText)
        if (request.status < 200 || request.status >= 300 || answer.error || !answer.id) {
          throw new Error(answer.error || 'Could not start your manual. Try again.')
        }
        resolve(answer)
      } catch (error) {
        reject(error instanceof SyntaxError ? new Error('Could not read the server response. Try again.') : error)
      }
    }
    request.onerror = () => reject(new Error('Could not reach the server. Try again.'))
    request.onabort = () => reject(new Error('Photo upload cancelled. Try again.'))
    request.send(body)
  })
}

// Shared by camera and library uploads. Only the encoded result leaves the device.
export async function preparePhoto(file) {
  const url = URL.createObjectURL(file)
  const image = new Image()
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve
      image.onerror = () => reject(new Error('Could not read this photo. Try a JPEG or PNG image.'))
      image.src = url
    })
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not prepare this photo. Please try again.')
    // Drawing also bakes in the browser-decoded orientation and removes camera metadata.
    // Flatten transparent images onto white before encoding as JPEG.
    for (let attempt = 0; attempt < 6; attempt++) {
      context.fillStyle = '#fff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      for (const quality of [0.8, 0.65, 0.5]) {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
        if (!blob || blob.type !== 'image/jpeg') throw new Error('Could not compress this photo. Please try again.')
        if (blob.size <= 1_000_000) {
          return new File([blob], 'photo.jpg', { type: 'image/jpeg' })
        }
      }
      canvas.width = Math.max(1, Math.round(canvas.width * 0.75))
      canvas.height = Math.max(1, Math.round(canvas.height * 0.75))
    }
    throw new Error('Could not make this photo small enough. Please choose another photo.')
  } finally {
    URL.revokeObjectURL(url)
  }
}
