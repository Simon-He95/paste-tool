## paste-tool

Small helper for browser paste handlers that extracts formatted text or merges clipboard images into a single `Blob` while preserving layout.

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

The library exposes a single function, `onPaste(isImage, event)`, which resolves to either text (string) or an image `Blob` depending on the `isImage` flag.

### Handle Text Paste

```ts
import { onPaste } from 'paste-tool'

window.addEventListener('paste', async (event) => {
  try {
    const text = await onPaste(false, event)
    console.info('Received text:', text)
  }
  catch (error) {
    console.error('No text found in clipboard', error)
  }
})
```

The helper prioritizes HTML > RTF > plain text. When multiple fragments exist (for example files copied from Excel), it merges them while preserving layout and normalized line breaks.

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

When multiple images are detected, the library infers the clipboard layout (tables, block elements, line breaks) and composites the images into a single canvas. The output format reuses `image/png` or `image/webp` if present, otherwise defaults to PNG.

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

`onPaste(isImage: boolean, event?: ClipboardEvent | null): Promise<Blob | string>`

- `isImage`: `true` to request image blobs, `false` for text.
- `event`: optional paste event, used to synchronously access clipboard data when available.

Rejected promises carry an error explaining why no data was found.

## FAQ

- **Can I call `onPaste` without an event?** Yes. It will use the asynchronous clipboard API if accessible.
- **Does it support multiple images?** Yes. Images are merged into a single output according to clipboard hints; leftovers stack vertically.
- **What about bitmap cleanup?** Bitmaps created via `createImageBitmap` are closed automatically once the merge completes.

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
