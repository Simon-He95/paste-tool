import {
  canvasToBlob,
  closeBitmaps,
  createDrawingCanvas,
  loadBitmap,
} from './image-utils'

const HTML_SNAPSHOT_MAX_DIMENSION = 4096
const HTML_SNAPSHOT_DEFAULT_WIDTH = 512
const HTML_SNAPSHOT_DEFAULT_HEIGHT = 512

export interface HtmlSnapshotOptions {
  log?: (message: string, error: unknown) => void
  /**
   * Desired MIME type for the resulting blob. Defaults to `image/png`.
   * Use `image/jpeg` for lossy output, or `image/svg+xml` to skip rasterization
   * and return the serialized SVG directly.
   */
  mimeType?: string
}

interface HtmlSnapshotPlan {
  width: number
  height: number
  markup: string
}

export async function renderHtmlFragmentToImage(html: string, options: HtmlSnapshotOptions = {}): Promise<Blob | null> {
  if (!html)
    return null

  const mimeType = options.mimeType ?? 'image/png'
  const normalizedOptions: HtmlSnapshotOptions = { ...options, mimeType }

  const plan = prepareHtmlSnapshot(html, mimeType)
  if (!plan)
    return null

  const svgMarkup = buildForeignObjectSvg(plan)
  return await rasterizeSvgMarkup(svgMarkup, plan.width, plan.height, normalizedOptions)
}

function prepareHtmlSnapshot(html: string, mimeType: string): HtmlSnapshotPlan | null {
  if (typeof document === 'undefined' || !document.body) {
    if (mimeType === 'image/svg+xml') {
      const markup = wrapInlineHtmlForSvg(html)
      return {
        width: HTML_SNAPSHOT_DEFAULT_WIDTH,
        height: HTML_SNAPSHOT_DEFAULT_HEIGHT,
        markup,
      }
    }
    return null
  }

  const sandbox = document.createElement('div')
  sandbox.style.position = 'fixed'
  sandbox.style.left = '-10000px'
  sandbox.style.top = '-10000px'
  sandbox.style.pointerEvents = 'none'
  sandbox.style.zIndex = '-1'
  sandbox.style.visibility = 'hidden'
  sandbox.style.contain = 'layout style'

  const measuringRoot = document.createElement('div')
  measuringRoot.style.display = 'inline-block'
  measuringRoot.innerHTML = html
  sandbox.appendChild(measuringRoot)
  document.body.appendChild(sandbox)

  let width = HTML_SNAPSHOT_DEFAULT_WIDTH
  let height = HTML_SNAPSHOT_DEFAULT_HEIGHT

  try {
    const rect = measuringRoot.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      width = clampDimension(rect.width)
      height = clampDimension(rect.height)
    }

    const xhtmlWrapper = document.createElementNS('http://www.w3.org/1999/xhtml', 'div')
    xhtmlWrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
    xhtmlWrapper.setAttribute('style', 'display:inline-block')

    const nodes = measuringRoot.childNodes
    for (let index = 0; index < nodes.length; index++)
      xhtmlWrapper.appendChild(nodes[index].cloneNode(true))

    const serializer = new XMLSerializer()
    const markup = serializer.serializeToString(xhtmlWrapper)

    return {
      width,
      height,
      markup,
    }
  }
  finally {
    document.body.removeChild(sandbox)
  }
}

function wrapInlineHtmlForSvg(html: string): string {
  return `<div xmlns="http://www.w3.org/1999/xhtml" style="display:inline-block">${html}</div>`
}

function buildForeignObjectSvg(plan: HtmlSnapshotPlan): string {
  const width = Math.max(1, Math.round(plan.width))
  const height = Math.max(1, Math.round(plan.height))
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject width="100%" height="100%" requiredExtensions="http://www.w3.org/1999/xhtml">${plan.markup}</foreignObject></svg>`
}

async function rasterizeSvgMarkup(svgMarkup: string, width: number, height: number, options: HtmlSnapshotOptions): Promise<Blob | null> {
  const { log, mimeType } = options
  const targetMime = mimeType ?? 'image/png'

  if (targetMime === 'image/svg+xml') {
    try {
      return new Blob([svgMarkup], { type: 'image/svg+xml' })
    }
    catch (error) {
      log?.('Failed to serialize SVG snapshot.', error)
      return null
    }
  }

  try {
    const svgBlob = new Blob([svgMarkup], { type: 'image/svg+xml' })
    if (!canUseCanvas2D()) {
      log?.('Canvas 2D context unavailable; returning SVG snapshot.', null)
      return svgBlob
    }

    const bitmap = await loadBitmap(svgBlob)
    try {
      const canvas = createDrawingCanvas(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)))
      const restoreConsole = muteCanvasNotImplementedWarnings()
      try {
        const ctx = canvas.getContext('2d')
        if (!ctx)
          throw new Error('Failed to access canvas 2D context.')

        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.save()
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.restore()
        ctx.drawImage(bitmap as CanvasImageSource, 0, 0)

        return await canvasToBlob(canvas, targetMime)
      }
      finally {
        if (restoreConsole)
          restoreConsole()
      }
    }
    finally {
      closeBitmaps([bitmap])
    }
  }
  catch (error) {
    log?.('Failed to rasterize HTML snapshot.', error)
  }

  try {
    const fallbackType = targetMime === 'image/svg+xml' ? 'image/svg+xml' : 'image/svg+xml'
    return new Blob([svgMarkup], { type: fallbackType })
  }
  catch {
    return null
  }
}

function canUseCanvas2D(): boolean {
  if (typeof document === 'undefined')
    return false

  if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string' && navigator.userAgent.includes('jsdom'))
    return false

  const contextCtor = (globalThis as { CanvasRenderingContext2D?: unknown }).CanvasRenderingContext2D
  if (typeof contextCtor === 'undefined')
    return false

  const canvas = document.createElement('canvas')
  return typeof canvas.getContext === 'function'
}

function clampDimension(value: number): number {
  const rounded = Math.ceil(value)
  if (rounded <= 0)
    return 1
  if (rounded > HTML_SNAPSHOT_MAX_DIMENSION)
    return HTML_SNAPSHOT_MAX_DIMENSION
  return rounded
}

function muteCanvasNotImplementedWarnings(): (() => void) | null {
  if (typeof console === 'undefined')
    return null

  const originalError = console.error
  const originalWarn = console.warn

  const filter = (logger: (...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
      const first = args[0]
      if (typeof first === 'string' && first.includes('HTMLCanvasElement\'s getContext() method'))
        return
      logger(...args)
    }
  }

  console.error = filter(originalError)
  console.warn = filter(originalWarn)

  return () => {
    console.error = originalError
    console.warn = originalWarn
  }
}
