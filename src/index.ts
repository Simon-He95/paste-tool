/// <reference lib="dom" />

const IMAGE_MIME_PREFIX = 'image/'
const HTML_MIME = 'text/html'
const RTF_MIME = 'text/rtf'
const PLAIN_MIME = 'text/plain'
// Prefer richer formats to keep layout when available.
const TEXT_MIME_PRIORITY = [HTML_MIME, RTF_MIME, PLAIN_MIME] as const
const HTML_BREAK_SPLIT_PATTERN = /<br\s*(?:\/\s*)?>/i
const HTML_IMG_TAG_PATTERN = /<img\b/gi
const LINE_BREAK_TEST_PATTERN = /[\r\n]/
const LINE_BREAK_NORMALIZE_PATTERN = /\r?\n/g
const SHARED_DOM_PARSER = typeof DOMParser !== 'undefined' ? new DOMParser() : null

type TextMime = typeof TEXT_MIME_PRIORITY[number]

class TextCollector {
  private readonly buckets = new Map<TextMime, string[]>()

  add(mime: TextMime, fragment: string) {
    const bucket = this.buckets.get(mime)
    if (bucket) {
      bucket.push(fragment)
      return
    }
    this.buckets.set(mime, [fragment])
  }

  merge(): string | null {
    for (const mime of TEXT_MIME_PRIORITY) {
      const fragments = this.buckets.get(mime)
      if (!fragments || fragments.length === 0)
        continue
      if (fragments.length === 1)
        return fragments[0]

      if (mime === 'text/html')
        return combineHtmlFragments(fragments)
      if (mime === 'text/rtf')
        return combineRtfFragments(fragments)
      return combinePlainTextFragments(fragments)
    }

    return null
  }
}

function hasClipboardType(
  types: DOMStringList | readonly string[] | undefined,
  mime: string,
): boolean {
  if (!types)
    return false

  if (Array.isArray(types))
    return types.includes(mime)

  if (typeof (types as DOMStringList).contains === 'function')
    return (types as DOMStringList).contains(mime)

  const list = types as DOMStringList
  for (let index = 0; index < list.length; index++) {
    if (list.item(index) === mime)
      return true
  }

  return false
}

/**
 * Reads clipboard content captured during a paste operation.
 * @param isImage When true, resolves with an image {@link Blob}; otherwise returns formatted text.
 * @param event Optional `ClipboardEvent` from the paste handler to read synchronously available data.
 */
export async function onPaste(
  isImage: boolean,
  event?: ClipboardEvent | null,
): Promise<Blob | string> {
  assertBrowserEnvironment()

  if (isImage) {
    const fromEvent = collectImagesFromEvent(event)
    const fromNavigator = fromEvent.blobs.length > 0 ? null : await collectImagesFromNavigator()
    const blobs = [...fromEvent.blobs, ...(fromNavigator?.blobs ?? [])]
    const layoutHtml = fromEvent.html ?? fromNavigator?.html ?? null

    if (blobs.length === 0)
      throw new Error('No image data found in clipboard.')

    if (blobs.length === 1)
      return blobs[0]

    return await mergeImages(blobs, layoutHtml)
  }

  const text = await extractText({ event })
  if (text !== null)
    return text

  throw new Error('No textual data found in clipboard.')
}

export default onPaste

function assertBrowserEnvironment() {
  if (typeof window === 'undefined')
    throw new Error('Paste handling requires a browser environment.')
}

interface ClipboardImagePayload {
  blobs: Blob[]
  html: string | null
}

function collectImagesFromEvent(event?: ClipboardEvent | null): ClipboardImagePayload {
  const clipboardData = event?.clipboardData
  if (!clipboardData)
    return { blobs: [], html: null }

  const html = hasClipboardType(clipboardData.types, HTML_MIME) ? clipboardData.getData(HTML_MIME) : null
  const blobs = collectBlobsFromDataTransfer(clipboardData)
  return { blobs, html }
}

async function collectImagesFromNavigator(): Promise<ClipboardImagePayload | null> {
  if (typeof navigator === 'undefined' || !navigator.clipboard)
    return null

  const clipboard = navigator.clipboard as Clipboard & {
    read?: () => Promise<ClipboardItem[]>
  }

  if (typeof clipboard.read !== 'function')
    return null

  const blobs: Blob[] = []
  let html: string | null = null
  try {
    const items = await clipboard.read()
    const payloads = await Promise.all(items.map(item => collectBlobsFromClipboardItem(item)))
    for (const payload of payloads) {
      blobs.push(...payload.blobs)
      if (!html && payload.html)
        html = payload.html
    }
  }
  catch (error) {
    logClipboardWarning('navigator.clipboard.read failed', error)
  }

  if (blobs.length === 0)
    return null

  return { blobs, html }
}

function collectBlobsFromDataTransfer(data: DataTransfer): Blob[] {
  const blobs: Blob[] = []

  const items = data.items
  if (items) {
    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      const file = item.getAsFile()
      if (file && file.type.startsWith(IMAGE_MIME_PREFIX))
        blobs.push(file)
    }
  }

  const files = data.files
  if (files) {
    for (let index = 0; index < files.length; index++) {
      const file = files.item(index)
      if (file && file.type.startsWith(IMAGE_MIME_PREFIX))
        blobs.push(file)
    }
  }

  return blobs
}

async function collectBlobsFromClipboardItem(item: ClipboardItem): Promise<ClipboardImagePayload> {
  const blobs: Blob[] = []
  let html: string | null = null
  for (const type of item.types) {
    if (type.startsWith(IMAGE_MIME_PREFIX))
      blobs.push(await item.getType(type))
    else if (!html && type === HTML_MIME)
      html = await (await item.getType(type)).text()
  }
  return { blobs, html }
}

async function extractText({ event }: { event?: ClipboardEvent | null }): Promise<string | null> {
  const clipboardData = event?.clipboardData
  if (clipboardData) {
    for (const mime of TEXT_MIME_PRIORITY) {
      if (hasClipboardType(clipboardData.types, mime))
        return clipboardData.getData(mime)
    }
  }

  if (typeof navigator === 'undefined' || !navigator.clipboard)
    return null

  const clipboard = navigator.clipboard as Clipboard & {
    read?: () => Promise<ClipboardItem[]>
  }

  const collector = new TextCollector()

  if (typeof clipboard.read === 'function') {
    try {
      const items = await clipboard.read()
      const batches = await Promise.all(items.map(async (item) => {
        const fragments: Array<{ mime: TextMime, fragment: string }> = []
        for (const mime of TEXT_MIME_PRIORITY) {
          if (!item.types.includes(mime))
            continue
          const blob = await item.getType(mime)
          const fragment = await blob.text()
          fragments.push({ mime, fragment })
        }
        return fragments
      }))

      for (const fragments of batches) {
        for (const { mime, fragment } of fragments)
          collector.add(mime, fragment)
      }

      const merged = collector.merge()
      if (merged !== null)
        return merged
    }
    catch (error) {
      logClipboardWarning('navigator.clipboard.read failed', error)
    }
  }

  if (typeof clipboard.readText === 'function') {
    try {
      const text = await clipboard.readText()
      collector.add(PLAIN_MIME, text)
    }
    catch (error) {
      logClipboardWarning('navigator.clipboard.readText failed', error)
    }
  }

  const merged = collector.merge()
  if (merged !== null)
    return merged

  return null
}

function combineHtmlFragments(fragments: string[]): string {
  if (fragments.length <= 1)
    return fragments[0] ?? ''

  const baseDoc = parseHtmlDocument('<div></div>')
  if (!baseDoc)
    return fragments.join('\n')

  const container = baseDoc.body.firstElementChild
  if (!container)
    return fragments.join('\n')

  const elementContainer = container as Element

  const compositeTable = baseDoc.createElement('table')
  let appended = false

  const adopt = <T extends Node>(node: T): T => baseDoc.importNode(node, true) as T

  for (const fragment of fragments) {
    const fragmentDoc = parseHtmlDocument(fragment)
    if (!fragmentDoc) {
      appendPlainRow(baseDoc, compositeTable, fragment)
      appended = true
      continue
    }

    const table = fragmentDoc.querySelector('table')
    if (table) {
      const rows = table.rows
      for (let index = 0; index < rows.length; index++)
        compositeTable.appendChild(adopt(rows[index]))
      appended = true
      continue
    }

    const fragmentRows = fragmentDoc.querySelectorAll('tr')
    if (fragmentRows.length > 0) {
      for (let index = 0; index < fragmentRows.length; index++)
        compositeTable.appendChild(adopt(fragmentRows[index]))
      appended = true
      continue
    }

    const row = baseDoc.createElement('tr')
    const cell = baseDoc.createElement('td')
    const nodes = fragmentDoc.body.childNodes
    if (nodes.length === 0)
      cell.innerHTML = '&nbsp;'
    else
      appendChildNodes(cell, nodes, adopt)
    row.appendChild(cell)
    compositeTable.appendChild(row)
    appended = true
  }

  if (!appended) {
    elementContainer.innerHTML = fragments.join('')
    return elementContainer.innerHTML
  }

  elementContainer.appendChild(compositeTable)
  return elementContainer.innerHTML
}

function parseHtmlDocument(markup: string): Document | null {
  if (!SHARED_DOM_PARSER)
    return null

  try {
    return SHARED_DOM_PARSER.parseFromString(markup, 'text/html')
  }
  catch {
    return null
  }
}

function appendPlainRow(doc: Document, table: HTMLTableElement, content: string): void {
  const row = doc.createElement('tr')
  const cell = doc.createElement('td')
  if (content)
    cell.innerHTML = content
  else
    cell.innerHTML = '&nbsp;'
  row.appendChild(cell)
  table.appendChild(row)
}

function appendChildNodes(
  target: Node & ParentNode,
  nodes: NodeListOf<ChildNode>,
  adopt: <T extends Node>(node: T) => T,
): void {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes.item(index)
    if (node)
      target.appendChild(adopt(node))
  }
}

function combineRtfFragments(fragments: string[]): string {
  return fragments[0] ?? ''
}

function combinePlainTextFragments(fragments: string[]): string {
  if (fragments.length === 0)
    return ''

  const hasLineBreak = fragments.some(fragment => LINE_BREAK_TEST_PATTERN.test(fragment))
  const separator = hasLineBreak ? '\n' : '\t'
  const combined = fragments.join(separator)
  return combined.replace(LINE_BREAK_NORMALIZE_PATTERN, '\n')
}

async function mergeImages(blobs: Blob[], html: string | null): Promise<Blob> {
  const bitmaps = await Promise.all(blobs.map(loadBitmap))
  try {
    const layout = inferImageLayout(bitmaps, html)
    const canvas = createDrawingCanvas(layout.width, layout.height)
    const ctx = canvas.getContext('2d')
    if (!ctx)
      throw new Error('Failed to access canvas 2D context.')

    ctx.clearRect(0, 0, layout.width, layout.height)

    for (let index = 0; index < layout.positions.length; index++) {
      const { x, y } = layout.positions[index]
      ctx.drawImage(bitmaps[index] as CanvasImageSource, x, y)
    }

    const mimeType = selectOutputMimeType(blobs)
    return await canvasToBlob(canvas, mimeType)
  }
  finally {
    closeBitmaps(bitmaps)
  }
}

type LoadedBitmap = ImageBitmap | HTMLImageElement

function isHtmlImageElement(value: LoadedBitmap): value is HTMLImageElement {
  return 'naturalWidth' in value
}

async function loadBitmap(blob: Blob): Promise<LoadedBitmap> {
  if (typeof createImageBitmap === 'function')
    return await createImageBitmap(blob)

  return await blobToHtmlImage(blob)
}

async function blobToHtmlImage(blob: Blob): Promise<HTMLImageElement> {
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

function createDrawingCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
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

async function canvasToBlob(canvas: HTMLCanvasElement | OffscreenCanvas, type: string): Promise<Blob> {
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

function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, data] = dataUrl.split(',')
  const mime = /data:([^;]+);/.exec(meta)?.[1] ?? 'image/png'
  const binary = atob(data)
  const buffer = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++)
    buffer[index] = binary.charCodeAt(index)

  return new Blob([buffer], { type: mime })
}

interface ImageLayout {
  width: number
  height: number
  positions: Array<{ x: number, y: number }>
}

function inferImageLayout(bitmaps: LoadedBitmap[], html: string | null): ImageLayout {
  const rows = deriveRowStructure(bitmaps.length, html)
  return buildLayoutFromRows(bitmaps, rows ?? [bitmaps.length])
}

function deriveRowStructure(count: number, html: string | null): number[] | null {
  if (!html)
    return null

  HTML_IMG_TAG_PATTERN.lastIndex = 0
  if (!HTML_IMG_TAG_PATTERN.test(html))
    return null
  HTML_IMG_TAG_PATTERN.lastIndex = 0

  const doc = parseHtmlDocument(html)
  if (doc) {
    const tableRows = extractRowsFromTables(doc)
    if (tableRows && sumCounts(tableRows) === count)
      return tableRows

    const blockRows = extractRowsFromBlockElements(doc)
    if (blockRows && sumCounts(blockRows) === count)
      return blockRows
  }

  const breakRows = extractRowsFromBreaks(html)
  if (breakRows && sumCounts(breakRows) === count)
    return breakRows

  return null
}

function extractRowsFromTables(doc: Document): number[] | null {
  const rows: number[] = []
  const tableRows = doc.querySelectorAll('tr')
  for (let index = 0; index < tableRows.length; index++) {
    const tr = tableRows[index]
    const count = tr.querySelectorAll('img').length
    if (count > 0)
      rows.push(count)
  }

  return rows.length > 0 ? rows : null
}

function extractRowsFromBreaks(html: string): number[] | null {
  const segments = html.split(HTML_BREAK_SPLIT_PATTERN)
  const rows: number[] = []
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]
    HTML_IMG_TAG_PATTERN.lastIndex = 0
    const matches = segment.match(HTML_IMG_TAG_PATTERN)
    const count = matches ? matches.length : 0
    if (count > 0)
      rows.push(count)
  }

  return rows.length > 0 ? rows : null
}

function extractRowsFromBlockElements(doc: Document): number[] | null {
  const selectors = ['p', 'div', 'section', 'article', 'figure']
  const rows: number[] = []
  for (let selectorIndex = 0; selectorIndex < selectors.length; selectorIndex++) {
    const elements = doc.querySelectorAll(selectors[selectorIndex])
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index]
      const count = element.querySelectorAll('img').length
      if (count > 0)
        rows.push(count)
    }
    if (rows.length > 0)
      break
  }

  return rows.length > 0 ? rows : null
}

function buildLayoutFromRows(bitmaps: LoadedBitmap[], rowCounts: number[]): ImageLayout {
  const counts = rowCounts.filter(count => count > 0)
  const totalFromRows = sumCounts(counts)
  if (totalFromRows < bitmaps.length)
    counts.push(bitmaps.length - totalFromRows)

  const positions: Array<{ x: number, y: number }> = []
  let maxWidth = 0
  let yOffset = 0
  let index = 0

  for (const requestedCount of counts) {
    const remaining = bitmaps.length - index
    if (remaining <= 0)
      break

    const count = Math.min(requestedCount, remaining)
    let xOffset = 0
    let rowWidth = 0
    let rowHeight = 0

    const rowEnd = index + count
    for (let bitmapIndex = index; bitmapIndex < rowEnd; bitmapIndex++) {
      const bitmap = bitmaps[bitmapIndex]
      const width = getBitmapWidth(bitmap)
      const height = getBitmapHeight(bitmap)
      positions.push({ x: xOffset, y: yOffset })
      xOffset += width
      rowWidth += width
      if (height > rowHeight)
        rowHeight = height
    }

    maxWidth = Math.max(maxWidth, rowWidth)
    yOffset += rowHeight
    index = rowEnd
  }

  if (index < bitmaps.length) {
    for (let extra = index; extra < bitmaps.length; extra++) {
      positions.push({ x: 0, y: yOffset })
      const bitmap = bitmaps[extra]
      const height = getBitmapHeight(bitmap)
      const width = getBitmapWidth(bitmap)
      maxWidth = Math.max(maxWidth, width)
      yOffset += height
    }
  }

  const width = Math.max(1, maxWidth)
  const height = Math.max(1, yOffset)

  return {
    width,
    height,
    positions,
  }
}

function getBitmapWidth(bitmap: LoadedBitmap): number {
  return isHtmlImageElement(bitmap) ? bitmap.naturalWidth : bitmap.width
}

function getBitmapHeight(bitmap: LoadedBitmap): number {
  return isHtmlImageElement(bitmap) ? bitmap.naturalHeight : bitmap.height
}

function selectOutputMimeType(blobs: Blob[]): string {
  const preferred = blobs.find(blob => blob.type === 'image/png' || blob.type === 'image/webp')
  if (preferred)
    return preferred.type

  const fallback = blobs.find(blob => blob.type.startsWith('image/'))
  return fallback?.type || 'image/png'
}

function sumCounts(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function closeBitmaps(bitmaps: LoadedBitmap[]): void {
  for (const bitmap of bitmaps) {
    if ('close' in bitmap && typeof bitmap.close === 'function')
      bitmap.close()
  }
}

function logClipboardWarning(message: string, error: unknown) {
  if (typeof console === 'undefined')
    return

  const meta = import.meta as unknown as { env?: { DEV?: boolean } } | undefined
  if (meta?.env?.DEV ?? false)
    console.warn(message, error)
}
