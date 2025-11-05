<template>
  <div class="page">
    <header>
      <h1>paste-tool × Vue Playground</h1>
      <p>
        Paste into either panel below to inspect the helper output. Hold focus with a click before pasting
        (<kbd>⌘</kbd> / <kbd>Ctrl</kbd> + <kbd>V</kbd>).
      </p>
    </header>

    <section class="grid">
      <article
        class="panel"
        tabindex="0"
        role="textbox"
        aria-label="Paste text here"
        contenteditable
        @paste="handleTextPaste"
      >
        <h2>Text Paste</h2>
        <p class="hint">Preserves HTML/RTF when available. Result below originates from <code>onPaste(false)</code>.</p>
        <div class="result">
          <h3>Combined Text</h3>
          <textarea readonly :value="textResult" placeholder="Paste rich text here"></textarea>
        </div>
        <div class="result" v-if="htmlPreview">
          <h3>HTML Preview</h3>
          <div class="html-preview" v-html="htmlPreview" />
        </div>
      </article>

      <article
        class="panel"
        tabindex="0"
        role="button"
        aria-label="Paste images here"
        contenteditable
        @paste="handleImagePaste"
      >
        <h2>Image Paste</h2>
        <p class="hint">Multiple images are merged with inferred layout. Result below comes from <code>onPaste(true)</code>.</p>
        <div class="result image">
          <img v-if="imageUrl" :src="imageUrl" alt="Pasted preview" />
          <p v-else class="placeholder">Paste one or more images here.</p>
        </div>
      </article>
    </section>

    <aside v-if="error" class="error">{{ error }}</aside>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { onPaste } from '../../../src'

const textResult = ref('')
const htmlPreview = ref('')
const imageUrl = ref<string | null>(null)
const error = ref('')

let objectUrl: string | null = null

function resetError() {
  error.value = ''
}

async function handleTextPaste(event: ClipboardEvent) {
  event.preventDefault()
  resetError()

  try {
    const result = await onPaste(false, event)
    textResult.value = typeof result === 'string' ? result : ''
    htmlPreview.value = event.clipboardData?.getData('text/html') ?? ''
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function handleImagePaste(event: ClipboardEvent) {
  event.preventDefault()
  resetError()

  try {
    const payload = await onPaste(true, event)
    if (payload instanceof Blob)
      assignImageBlob(payload)
    else
      throw new Error('Clipboard did not include image data.')
  }
  catch (err) {
    clearImage()
    error.value = err instanceof Error ? err.message : String(err)
  }
}

function assignImageBlob(blob: Blob) {
  if (objectUrl)
    URL.revokeObjectURL(objectUrl)

  objectUrl = URL.createObjectURL(blob)
  imageUrl.value = objectUrl
}

function clearImage() {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = null
  }
  imageUrl.value = null
}

onBeforeUnmount(() => {
  if (objectUrl)
    URL.revokeObjectURL(objectUrl)
})
</script>

<style scoped>
.page {
  margin: 0 auto;
  padding: 2rem 1.5rem 3rem;
  max-width: 960px;
  display: flex;
  flex-direction: column;
  gap: 2rem;
}

header h1 {
  margin: 0;
  font-size: 2rem;
}

header p {
  margin: 0.5rem 0 0;
  line-height: 1.6;
  color: rgba(255, 255, 255, 0.72);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1.5rem;
}

.panel {
  border: 1px solid rgba(255, 255, 255, 0.24);
  border-radius: 12px;
  padding: 1.5rem;
  background: rgba(17, 24, 39, 0.65);
  outline: none;
  min-height: 320px;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.panel:focus-visible {
  border-color: #22d3ee;
  box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.3);
}

.panel h2 {
  margin: 0;
  font-size: 1.3rem;
}

.hint {
  margin: 0;
  font-size: 0.95rem;
  color: rgba(255, 255, 255, 0.6);
}

.result {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.result textarea {
  width: 100%;
  min-height: 150px;
  border-radius: 8px;
  border: none;
  padding: 0.75rem;
  resize: vertical;
  font-family: Consolas, 'Source Code Pro', ui-monospace, monospace;
  font-size: 0.95rem;
  background: rgba(255, 255, 255, 0.08);
  color: inherit;
}

.html-preview {
  padding: 1rem;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  min-height: 120px;
}

.result.image {
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.08);
  padding: 1rem;
  min-height: 180px;
}

.result.image img {
  max-width: 100%;
  max-height: 260px;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
}

.placeholder {
  margin: 0;
  color: rgba(255, 255, 255, 0.5);
  font-size: 0.95rem;
}

.error {
  padding: 1rem 1.25rem;
  background: rgba(248, 113, 113, 0.15);
  border: 1px solid rgba(248, 113, 113, 0.4);
  border-radius: 8px;
  color: #fecaca;
}

code {
  font-family: Consolas, 'Source Code Pro', ui-monospace, monospace;
  background: rgba(255, 255, 255, 0.08);
  padding: 0.15rem 0.35rem;
  border-radius: 4px;
}

kbd {
  font-family: inherit;
  font-size: 0.82rem;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  background: rgba(255, 255, 255, 0.12);
}
</style>
