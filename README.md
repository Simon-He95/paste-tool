## paste-tool

Paste smarter. paste-tool is a tiny, dependency-free browser helper that makes paste handlers reliable and delightful: extract rich text cleanly (HTML/RTF/plain), or merge multiple pasted images into a single layout-preserving image Blob.

It targets scenarios where users paste from complex sources (Excel, Word, remote desktops, screenshots) and you want a consistent payload for uploads, previews, or editor insertion.

## Installation

```bash
pnpm add paste-tool
```

```bash
npm install paste-tool
```

```bash
yarn add paste-tool
```

## Usage

The library exposes a single function, `onPaste(isImage, event)`, which resolves to either a `ClipboardTextPayload` (rich text + plain text) or an image `Blob` depending on the `isImage` flag. It's intentionally minimal to slot into any web app or editor.

### Handle Text Paste

```ts
import { onPaste } from 'paste-tool'

window.addEventListener('paste', async (event) => {
  try {
    const payload = await onPaste(false, event)
    console.info('Preferred text:', payload.preferred)
    console.info('HTML:', payload.html)
    console.info('Plain text:', payload.plain)
  }
  catch (error) {
    console.error('No text found in clipboard', error)
  }
})
```

The helper prioritizes HTML > RTF > plain text. When multiple fragments exist (for example files copied from Excel), it merges them while preserving layout and normalized line breaks.

Quick highlights:
- Returns an object with `html`, `rtf`, and `plain` when text is requested.
- Automatically merges multiple fragments (tables/rows) into single HTML or plain text output.
- Falls back to async clipboard APIs when synchronous event data is missing.

### Handle Image Paste

```ts
import { onPaste } from 'paste-tool'

window.addEventListener('paste', async (event) => {
  try {
    const blob = await onPaste(true, event)
    const imageUrl = URL.createObjectURL(blob)
    document.querySelector('img#preview')!.src = imageUrl
  }
  catch (error) {
    console.error('No image found in clipboard', error)
  }
})
```

When multiple images are detected, the library infers the clipboard layout (table/grid, stacked blocks, or line-break-separated rows) and composites images into a single canvas, preserving visual order. The output format reuses `image/png` or `image/webp` when available, otherwise falls back to PNG.

If no image blobs are available (some paste sources expose images as HTML/text), `onPaste(true, ...)` will return the `ClipboardTextPayload` instead — so your consumer code can gracefully fall back to inserting formatted text.

### Handle Image Paste Fallback

Some environments (for example remote desktops or certain web apps) surface images as formatted text. You can detect that case and reuse the text payload without writing additional clipboard access logic:

```ts
import type { ClipboardTextPayload } from 'paste-tool'
import { onPaste } from 'paste-tool'

function isTextPayload(value: unknown): value is ClipboardTextPayload {
  return typeof value === 'object' && value !== null && 'plain' in value
}

window.addEventListener('paste', async (event) => {
  event.preventDefault()
  try {
    const result = await onPaste(true, event)
    if (result instanceof Blob) {
      const imageUrl = URL.createObjectURL(result)
      document.querySelector('img#preview')!.src = imageUrl
      return
    }

    if (isTextPayload(result)) {
      console.info('Falling back to text paste:', result.preferred)
      return
    }

    console.warn('Clipboard did not include image or text data')
  }
  catch (error) {
    console.error('Paste failed:', error)
  }
})
```

### Async Clipboard Fallbacks

If the synchronous `ClipboardEvent` lacks the needed data, the helper falls back to `navigator.clipboard.read()` / `readText()` (where supported). Error logs are emitted only in development environments.

## Playground

A Vue playground lives in `playground/vue` for manual testing. Run it with:

```bash
pnpm install
pnpm --filter paste-tool-playground dev
```

This launches Vite on `http://localhost:5173`, where you can paste rich text or multiple images to inspect the results live.

## API

`onPaste(isImage: boolean, event?: ClipboardEvent | null): Promise<Blob | ClipboardTextPayload>`

- `isImage`: `true` to request image blobs, `false` for text.
- `event`: optional paste event, used to synchronously access clipboard data when available.

```ts
interface ClipboardTextPayload {
  html: string | null
  rtf: string | null
  plain: string | null
  /**
   * Preferred representation (HTML > RTF > plain) for quick consumption.
   */
  preferred: string | null
}
```

Rejected promises carry an error explaining why no data was found.

## FAQ

- **Can I call `onPaste` without an event?** Yes. It will use the asynchronous clipboard API if accessible.
- **Does it support multiple images?** Yes. Images are merged into a single output according to clipboard hints; leftovers stack vertically.
- **What about bitmap cleanup?** Bitmaps created via `createImageBitmap` are closed automatically once the merge completes.

## Why use paste-tool?

- Simple API: one function for text or images.
- Robust: merges multi-fragment text, infers image layout, and falls back to async clipboard when needed.
- Lightweight: no runtime dependencies — ship it to the browser and forget.

## Contributing

PRs and issues are welcome. If you spot a paste scenario that yields unexpected output (browser, OS, source app), please open an issue with a short reproduction.

## Development

Run:

```bash
pnpm install
pnpm run typecheck
pnpm run lint
pnpm test
```

Note: installing devDependencies is required before `lint` and `test` will work locally.

## Development

```bash
pnpm install
pnpm lint
pnpm test
```

## License

[MIT](./license)

## Sponsors

[buy me a cup of coffee](https://github.com/Simon-He95/sponsor)
