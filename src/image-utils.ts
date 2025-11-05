export type LoadedBitmap = ImageBitmap | HTMLImageElement

export function isHtmlImageElement(value: LoadedBitmap): value is HTMLImageElement {
  return 'naturalWidth' in value
}

export async function loadBitmap(blob: Blob): Promise<LoadedBitmap> {
  if (typeof createImageBitmap === 'function')
    return await createImageBitmap(blob)

  return await blobToHtmlImage(blob)
}

export async function blobToHtmlImage(blob: Blob): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = (event) => {
      URL.revokeObjectURL(url)
      reject(event)
    }
    image.src = url
  })
}

export function createDrawingCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas
  }

  if (typeof OffscreenCanvas === 'function')
    return new OffscreenCanvas(width, height)

  throw new Error('Canvas rendering requires DOM or OffscreenCanvas support.')
}

export async function canvasToBlob(canvas: HTMLCanvasElement | OffscreenCanvas, type: string): Promise<Blob> {
  if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function')
    return await canvas.convertToBlob({ type })

  const domCanvas = canvas as HTMLCanvasElement
  return await new Promise<Blob>((resolve, reject) => {
    if (typeof domCanvas.toBlob === 'function') {
      domCanvas.toBlob((blob) => {
        if (blob)
          resolve(blob)
        else
          reject(new Error('Failed to export merged image.'))
      }, type)
      return
    }

    try {
      const dataUrl = domCanvas.toDataURL(type)
      resolve(dataUrlToBlob(dataUrl))
    }
    catch (error) {
      reject(error)
    }
  })
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, data] = dataUrl.split(',')
  const mime = /data:([^;]+);/.exec(meta)?.[1] ?? 'image/png'
  const binary = atob(data)
  const buffer = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++)
    buffer[index] = binary.charCodeAt(index)

  return new Blob([buffer], { type: mime })
}

export function closeBitmaps(bitmaps: LoadedBitmap[]): void {
  for (const bitmap of bitmaps) {
    if ('close' in bitmap && typeof bitmap.close === 'function')
      bitmap.close()
  }
}
