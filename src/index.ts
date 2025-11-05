/// <reference lib="dom" />

import type { HtmlSnapshotOptions } from './htmlSnapshot'
import type { LoadedBitmap } from './image-utils'
import { renderHtmlFragmentToImage } from './htmlSnapshot'
import {
  canvasToBlob,
  closeBitmaps,
  createDrawingCanvas,
  dataUrlToBlob,
  isHtmlImageElement,
  loadBitmap,

} from './image-utils'

const IMAGE_MIME_PREFIX = 'image/'
const HTML_MIME = 'text/html'
const RTF_MIME = 'text/rtf'
const PLAIN_MIME = 'text/plain'
// Prefer richer formats to keep layout when available.
const TEXT_MIME_PRIORITY = [HTML_MIME, RTF_MIME, PLAIN_MIME] as const
const IMAGE_TYPE_PREFERENCE = ['image/png', 'image/webp', 'image/jpeg']
const HTML_BREAK_SPLIT_PATTERN = /<br\s*(?:\/\s*)?>/i
const HTML_IMG_TAG_PATTERN = /<img\b/gi
const INLINE_IMG_SRC_PATTERN = /<img[^>]*\ssrc=(['"])(.*?)\1/gi
const LINE_BREAK_TEST_PATTERN = /[\r\n]/
const LINE_BREAK_NORMALIZE_PATTERN = /\r?\n/g
const SHARED_DOM_PARSER = typeof DOMParser !== 'undefined' ? new DOMParser() : null

type TextMime = typeof TEXT_MIME_PRIORITY[number]

export interface ClipboardTextPayload {
  html: string | null
  rtf: string | null
  plain: string | null
}

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

  merge(): ClipboardTextPayload | null {
    const payload: ClipboardTextPayload = {
      html: null,
      rtf: null,
      plain: null,
    }

    const htmlFragments = this.buckets.get(HTML_MIME)
    if (htmlFragments && htmlFragments.length > 0)
      payload.html = htmlFragments.length === 1 ? htmlFragments[0] : combineHtmlFragments(htmlFragments)

    const rtfFragments = this.buckets.get(RTF_MIME)
    if (rtfFragments && rtfFragments.length > 0)
      payload.rtf = rtfFragments.length === 1 ? rtfFragments[0] : combineRtfFragments(rtfFragments)

    const plainFragments = this.buckets.get(PLAIN_MIME)
    if (plainFragments && plainFragments.length > 0)
      payload.plain = plainFragments.length === 1 ? plainFragments[0] : combinePlainTextFragments(plainFragments)

    if (payload.html !== null || payload.rtf !== null || payload.plain !== null)
      return payload

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
export interface PasteOptions {
  /**
   * When true (default), HTML fragments are rasterized into images if the clipboard
   * lacks explicit image blobs. Disable to skip the snapshot fallback for stricter
   * performance budgets.
   */
  enableHtmlSnapshot?: boolean
  /**
   * Options forwarded to the HTML snapshot renderer.
   */
  htmlSnapshotOptions?: HtmlSnapshotOptions
}

export async function onPaste(
  isImage: boolean,
  event?: ClipboardEvent | null,
  options: PasteOptions = {},
): Promise<Blob | ClipboardTextPayload> {
  assertBrowserEnvironment()
  const {
    enableHtmlSnapshot = true,
    htmlSnapshotOptions,
  } = options

  if (isImage) {
    let payload = await collectImagesFromEvent(event)
    if (payload.blobs.length === 0)
      payload = await collectImagesFromNavigator()

    const blobs = payload.blobs
    const layoutHtml = payload.html

    if (blobs.length === 0) {
      if (layoutHtml && enableHtmlSnapshot) {
        const snapshotOptions = mergeHtmlSnapshotOptions(htmlSnapshotOptions)
        const snapshot = await renderHtmlFragmentToImage(layoutHtml, snapshotOptions)
        if (snapshot)
          return snapshot
      }
      const fallbackText = await extractText({ event })
      if (fallbackText !== null)
        return fallbackText
      throw new Error('No image data found in clipboard.')
    }
    if (blobs.length === 1) {
      if (!layoutHtml)
        return blobs[0]
      return await mergeImages(blobs, layoutHtml)
    }

    return await mergeImages(blobs, layoutHtml)
  }

  const text = await extractText({ event })
  if (text !== null)
    return text

  throw new Error('No textual data found in clipboard.')
}

export default onPaste

export async function renderHtmlToImage(html: string, options?: HtmlSnapshotOptions): Promise<Blob> {
  const snapshotOptions = mergeHtmlSnapshotOptions(options)
  const snapshot = await renderHtmlFragmentToImage(html, snapshotOptions)
  if (snapshot)
    return snapshot

  throw new Error('Unable to render HTML to image.')
}

function mergeHtmlSnapshotOptions(options?: HtmlSnapshotOptions): HtmlSnapshotOptions {
  if (options?.log)
    return options
  return { ...options, log: logClipboardWarning }
}

function assertBrowserEnvironment() {
  if (typeof window === 'undefined')
    throw new Error('Paste handling requires a browser environment.')
}

interface ClipboardImagePayload {
  blobs: Blob[]
  html: string | null
}

async function collectImagesFromEvent(event?: ClipboardEvent | null): Promise<ClipboardImagePayload> {
  const clipboardData = event?.clipboardData
  if (!clipboardData)
    return { blobs: [], html: null }

  const html = hasClipboardType(clipboardData.types, HTML_MIME) ? clipboardData.getData(HTML_MIME) : null
  const blobs = collectBlobsFromDataTransfer(clipboardData)
  const payload: ClipboardImagePayload = { blobs, html }
  await hydrateInlineImages(payload)
  return payload
}

async function collectImagesFromNavigator(): Promise<ClipboardImagePayload> {
  const blobs: Blob[] = []
  let html: string | null = null
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    return {
      blobs,
      html,
    }
  }

  const clipboard = navigator.clipboard as Clipboard & {
    read?: () => Promise<ClipboardItem[]>
  }

  if (typeof clipboard.read !== 'function') {
    return {
      blobs,
      html,
    }
  }
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

  const payload: ClipboardImagePayload = { blobs, html }
  await hydrateInlineImages(payload)
  return payload
}

async function hydrateInlineImages(payload: ClipboardImagePayload): Promise<void> {
  if (payload.blobs.length > 0 || !payload.html)
    return

  const inlineBlobs = await extractInlineImagesFromHtml(payload.html)
  if (inlineBlobs.length > 0)
    payload.blobs.push(...inlineBlobs)
}

function collectBlobsFromDataTransfer(data: DataTransfer): Blob[] {
  const blobs: Blob[] = []
  const seen = new Set<string>()

  const addFile = (file: File | null) => {
    if (!file || !file.type.startsWith(IMAGE_MIME_PREFIX))
      return

    const key = `${file.type}:${file.size}:${file.lastModified}`
    if (seen.has(key))
      return
    seen.add(key)
    blobs.push(file)
  }

  const items = data.items
  if (items && items.length > 0) {
    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      if (item.kind === 'file')
        addFile(item.getAsFile())
    }
    return blobs
  }

  const files = data.files
  if (files) {
    for (let index = 0; index < files.length; index++) {
      addFile(files.item(index))
    }
  }

  return blobs
}

async function collectBlobsFromClipboardItem(item: ClipboardItem): Promise<ClipboardImagePayload> {
  const blobs: Blob[] = []
  let html: string | null = null
  const preferredImageType = selectPreferredImageType(item.types)

  if (preferredImageType) {
    try {
      blobs.push(await item.getType(preferredImageType))
    }
    catch (error) {
      logClipboardWarning(`ClipboardItem.getType failed for ${preferredImageType}`, error)
    }
  }

  for (const type of item.types) {
    if (type === HTML_MIME && !html)
      html = await (await item.getType(type)).text()
  }
  const payload: ClipboardImagePayload = { blobs, html }
  await hydrateInlineImages(payload)
  return payload
}

function selectPreferredImageType(types: readonly string[]): string | null {
  for (const candidate of IMAGE_TYPE_PREFERENCE) {
    if (types.includes(candidate))
      return candidate
  }

  for (const type of types) {
    if (type.startsWith(IMAGE_MIME_PREFIX))
      return type
  }

  return null
}

async function extractInlineImagesFromHtml(html: string): Promise<Blob[]> {
  const sources = collectImageSourcesFromHtml(html)
  if (sources.length === 0)
    return []

  const unique = new Set(sources)
  const blobs: Blob[] = []
  for (const source of unique) {
    const blob = await resolveImageSourceToBlob(source)
    if (blob)
      blobs.push(blob)
  }

  return blobs
}

function collectImageSourcesFromHtml(html: string): string[] {
  const sources: string[] = []
  const doc = parseHtmlDocument(html)
  if (doc) {
    const images = doc.querySelectorAll('img[src]')
    for (let index = 0; index < images.length; index++) {
      const src = images[index].getAttribute('src')
      if (src)
        sources.push(src)
    }
  }

  if (sources.length === 0) {
    INLINE_IMG_SRC_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while (true) {
      match = INLINE_IMG_SRC_PATTERN.exec(html)
      if (!match)
        break

      const src = match[2]
      if (src)
        sources.push(src)
    }
  }

  return sources
}

async function resolveImageSourceToBlob(src: string): Promise<Blob | null> {
  if (src.startsWith('data:')) {
    try {
      return dataUrlToBlob(src)
    }
    catch (error) {
      logClipboardWarning('Failed to parse data URI image from HTML fragment.', error)
      return null
    }
  }

  if (typeof fetch === 'function' && (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('blob:'))) {
    try {
      const response = await fetch(src)
      if (!response.ok)
        return null
      const blob = await response.blob()
      if (blob.type && blob.type.startsWith(IMAGE_MIME_PREFIX))
        return blob
      if (!blob.type && blob.size > 0)
        return blob
    }
    catch (error) {
      logClipboardWarning(`Failed to fetch image source ${src}`, error)
    }
  }

  return null
}

async function extractText({ event }: { event?: ClipboardEvent | null }): Promise<ClipboardTextPayload | null> {
  const collector = new TextCollector()
  const clipboardData = event?.clipboardData
  if (clipboardData) {
    for (const mime of TEXT_MIME_PRIORITY) {
      if (!hasClipboardType(clipboardData.types, mime))
        continue
      const fragment = clipboardData.getData(mime)
      if (fragment)
        collector.add(mime, fragment)
    }

    const merged = collector.merge()
    if (merged !== null)
      return merged
  }

  if (typeof navigator === 'undefined' || !navigator.clipboard)
    return null

  const clipboard = navigator.clipboard as Clipboard & {
    read?: () => Promise<ClipboardItem[]>
  }

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
      if (text)
        collector.add(PLAIN_MIME, text)
    }
    catch (error) {
      logClipboardWarning('navigator.clipboard.readText failed', error)
    }
  }

  return collector.merge()
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
    // Ensure transparent snapshots still render against a solid baseline.
    ctx.save()
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, layout.width, layout.height)
    ctx.restore()

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

function logClipboardWarning(message: string, error: unknown) {
  if (typeof console === 'undefined')
    return

  const meta = import.meta as unknown as { env?: { DEV?: boolean } } | undefined
  if (meta?.env?.DEV ?? false)
    console.warn(message, error)
}
