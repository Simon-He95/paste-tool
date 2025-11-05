## 中文说明

_Read this in: [English](./README.md) · [中文](./README.zh-CN.md)_

[![npm version](https://img.shields.io/badge/npm-v0.0.1-blue)](#) [![license](https://img.shields.io/badge/license-MIT-green)](#)

paste-tool 是一个轻量、无运行时依赖的浏览器剪贴板辅助库：在粘贴时提取富文本（HTML/RTF/纯文本），或将多张粘贴的图片按原始布局合并为一张可预览/上传的图片 Blob。适用于从 Excel/Word/远程桌面或截图粘贴内容并需要稳定上游负载的场景。

## 目录

- 安装
- 快速开始
- API
- 示例
  - 文本粘贴
  - 图片粘贴
  - 图片回退
- Playground
- 功能亮点
- 常见问题
- 贡献
- 开发
- 许可
- README (English)

### 安装

```bash
pnpm add paste-tool
# 或
npm install paste-tool
# 或
yarn add paste-tool
```

### 快速开始

库暴露单一函数 `onPaste(isImage, event)`，根据 `isImage` 返回图片 `Blob` 或文本对象 `ClipboardTextPayload`。

#### 处理文本粘贴

```ts
import { onPaste } from 'paste-tool'

window.addEventListener('paste', async (event) => {
  try {
    const payload = await onPaste(false, event)
    console.log('首选内容:', payload.preferred)
    console.log('HTML:', payload.html)
    console.log('纯文本:', payload.plain)
  } catch (err) {
    console.error('剪贴板没有文本数据', err)
  }
})
```

特点：
- 优先级：HTML > RTF > 纯文本。
- 支持合并来自多片段（例如从表格复制）的内容，保留布局和换行方向（横向/纵向）。
- 当同步事件数据不足时，会回退使用异步剪贴板 API（navigator.clipboard）。

#### 处理图片粘贴

```ts
import { onPaste } from 'paste-tool'

window.addEventListener('paste', async (event) => {
  try {
    const blob = await onPaste(true, event)
    const url = URL.createObjectURL(blob)
    document.querySelector<HTMLImageElement>('#preview')!.src = url
  } catch (err) {
    console.error('剪贴板没有图片数据', err)
  }
})
```

当检测到多张图片时，库会根据剪贴板中携带的布局提示（HTML 片段、换行或表格结构）推断排列顺序并在画布上合成一张图片。输出优先使用 `image/png` 或 `image/webp`，否则降级为 PNG。

如果未找到图片但存在富文本（某些源把图片以 HTML/text 暴露），`onPaste(true, ...)` 会返回 `ClipboardTextPayload`，你可以根据该结果回退到文本处理逻辑。

#### 图片粘贴回退（示例）

```ts
import type { ClipboardTextPayload } from 'paste-tool'
import { onPaste } from 'paste-tool'

function isTextPayload(v: unknown): v is ClipboardTextPayload {
  return typeof v === 'object' && v !== null && 'plain' in v
}

window.addEventListener('paste', async (event) => {
  event.preventDefault()
  const result = await onPaste(true, event)
  if (result instanceof Blob) {
    // 使用图片
  } else if (isTextPayload(result)) {
    // 回退使用文本（例如 HTML 包含 <table>）
  }
})
```

### API

`onPaste(isImage: boolean, event?: ClipboardEvent | null): Promise<Blob | ClipboardTextPayload>`

类型：

```ts
interface ClipboardTextPayload {
  html: string | null
  rtf: string | null
  plain: string | null
  preferred: string | null // HTML > RTF > plain
}
```

失败时 Promise 会以错误信息拒绝（说明没有可用数据）。

### Playground

仓库内提供一个 Vue playground（`playground/vue`），用于手工测试。启动：

```bash
pnpm install
pnpm --filter paste-tool-playground dev
# 打开 http://localhost:5173 进行粘贴测试
```

### 常见问题

- 可以不传事件直接调用吗？  
  可以，函数会尝试使用 `navigator.clipboard.read()` / `readText()` 做异步读取（浏览器支持及权限要求视环境而定）。

- 支持多张图片合成吗？  
  支持，库会尽量按原始复制的布局合并（表格/行列/块状排列），无法完全确定时按合理默认堆叠。

- 生成的图片为何出现透明/背景差异？  
  有些源（或截图）会包含透明区域。库在合成时有选项填充白底以保证在深色 UI 中显示一致。若你希望自定义背景色，请在合成前对返回的 Blob 再次处理或打开对应选项（可在代码中调整）。

### 进阶与性能建议

- 采用 Promise.allSettled 并优先解码体积小的 Blob，可以更快获得预览。
- 使用 OffscreenCanvas + Worker 将合成放到工作线程可避免主线程阻塞。
- 对重复粘贴的相同图片维护缓存（key = type+size+lastModified）可减少解码成本。

### 贡献

欢迎提交 PR 或 Issue。请在 Issue 中说明浏览器、操作系统、粘贴来源与复现步骤（最好附上截图或最小复现）。

### 开发

```bash
pnpm install
pnpm run typecheck
pnpm run lint
pnpm test
```

### 许可

MIT

### 赞助

[buy me a cup of coffee](https://github.com/Simon-He95/sponsor)
