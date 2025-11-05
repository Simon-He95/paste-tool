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
}

interface HtmlSnapshotPlan {
  width: number
  height: number
  markup: string
}

export async function renderHtmlFragmentToImage(html: string, options: HtmlSnapshotOptions = {}): Promise<Blob | null> {
  if (!html)
    return null

  const plan = prepareHtmlSnapshot(html)
  if (!plan)
    return null

  const svgMarkup = buildForeignObjectSvg(plan)
  return await rasterizeSvgMarkup(svgMarkup, plan.width, plan.height, options.log)
}

function prepareHtmlSnapshot(html: string): HtmlSnapshotPlan | null {
  if (typeof document === 'undefined' || !document.body)
    return null

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

function buildForeignObjectSvg(plan: HtmlSnapshotPlan): string {
  const width = Math.max(1, Math.round(plan.width))
  const height = Math.max(1, Math.round(plan.height))
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject width="100%" height="100%" requiredExtensions="http://www.w3.org/1999/xhtml">${plan.markup}</foreignObject></svg>`
}

async function rasterizeSvgMarkup(svgMarkup: string, width: number, height: number, log?: (message: string, error: unknown) => void): Promise<Blob | null> {
  try {
    const svgBlob = new Blob([svgMarkup], { type: 'image/svg+xml' })
    if (!canUseCanvas2D())
      return svgBlob

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

        return await canvasToBlob(canvas, 'image/png')
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
    return new Blob([svgMarkup], { type: 'image/svg+xml' })
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
