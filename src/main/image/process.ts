import sharp from 'sharp'

export interface BBox {
  left: number
  top: number
  width: number
  height: number
}

export interface RgbaImage {
  data: Buffer
  width: number
  height: number
}

export async function readRgba(file: string): Promise<RgbaImage> {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

export async function writeRgba(img: RgbaImage, outPath: string): Promise<string> {
  await sharp(img.data, {
    raw: { width: img.width, height: img.height, channels: 4 }
  })
    .png()
    .toFile(outPath)
  return outPath
}

/** 根据 alpha 通道计算主体包围盒 */
export function alphaBBox(img: RgbaImage, threshold = 10): BBox | null {
  const { data, width, height } = img
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3]
      if (a > threshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/** alpha 覆盖率（0~1），用于判断是否已经去底 */
export function alphaCoverage(img: RgbaImage): number {
  const { data, width, height } = img
  let opaque = 0
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 16) opaque++
  }
  return opaque / (width * height)
}

/** 取四边像素的中位色作为背景色估计 */
function estimateBackground(img: RgbaImage): { r: number; g: number; b: number } {
  const { data, width, height } = img
  const samples: Array<[number, number, number]> = []
  const step = Math.max(1, Math.floor(Math.min(width, height) / 64))

  for (let x = 0; x < width; x += step) {
    for (const y of [0, height - 1]) {
      const i = (y * width + x) * 4
      if (data[i + 3] > 200) samples.push([data[i], data[i + 1], data[i + 2]])
    }
  }
  for (let y = 0; y < height; y += step) {
    for (const x of [0, width - 1]) {
      const i = (y * width + x) * 4
      if (data[i + 3] > 200) samples.push([data[i], data[i + 1], data[i + 2]])
    }
  }
  if (samples.length === 0) return { r: 255, g: 255, b: 255 }

  const median = (vals: number[]): number => {
    vals.sort((a, b) => a - b)
    return vals[Math.floor(vals.length / 2)]
  }
  return {
    r: median(samples.map((s) => s[0])),
    g: median(samples.map((s) => s[1])),
    b: median(samples.map((s) => s[2]))
  }
}

/**
 * 从四边向内的洪水填充去底。
 * 只移除与边缘连通的背景，不会误删主体内部的同色区域（如白色衣服）。
 */
export function removeBackgroundInPlace(img: RgbaImage, tolerance = 30): RgbaImage {
  const { data, width, height } = img
  const bg = estimateBackground(img)
  const tol2 = tolerance * tolerance
  const visited = new Uint8Array(width * height)
  const queue = new Int32Array(width * height)
  let qh = 0
  let qt = 0

  const matches = (idx: number): boolean => {
    const i = idx * 4
    if (data[i + 3] < 200) return true // 已透明，继续扩散
    const dr = data[i] - bg.r
    const dg = data[i + 1] - bg.g
    const db = data[i + 2] - bg.b
    return dr * dr + dg * dg + db * db <= tol2
  }

  const push = (idx: number): void => {
    if (visited[idx]) return
    visited[idx] = 1
    if (!matches(idx)) return
    queue[qt++] = idx
  }

  for (let x = 0; x < width; x++) {
    push(x)
    push((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    push(y * width)
    push(y * width + width - 1)
  }

  while (qh < qt) {
    const idx = queue[qh++]
    data[idx * 4 + 3] = 0
    const x = idx % width
    const y = (idx - x) / width
    if (x > 0) push(idx - 1)
    if (x < width - 1) push(idx + 1)
    if (y > 0) push(idx - width)
    if (y < height - 1) push(idx + width)
  }

  // 边缘羽化：与透明像素相邻的半透明化，消除硬锯齿
  const alphaCopy = Buffer.from(
    data.filter((_, i) => i % 4 === 3)
  )
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      const a = alphaCopy[idx]
      if (a === 0) continue
      const hasTransparentNeighbor =
        alphaCopy[idx - 1] === 0 || alphaCopy[idx + 1] === 0 || alphaCopy[idx - width] === 0 || alphaCopy[idx + width] === 0
      if (hasTransparentNeighbor) data[idx * 4 + 3] = Math.round(a * 0.65)
    }
  }

  return img
}

/** 裁到主体包围盒；主体为空时返回原图 */
export async function cropToContent(file: string, padding = 2): Promise<{ path: string; bbox: BBox | null }> {
  const img = await readRgba(file)
  const bbox = alphaBBox(img)
  if (!bbox) return { path: file, bbox: null }

  const left = Math.max(0, bbox.left - padding)
  const top = Math.max(0, bbox.top - padding)
  const width = Math.min(img.width - left, bbox.width + padding * 2)
  const height = Math.min(img.height - top, bbox.height + padding * 2)

  const buf = await sharp(file).extract({ left, top, width, height }).png().toBuffer()
  const out = file.replace(/\.png$/i, '-crop.png')
  await sharp(buf).toFile(out)
  return { path: out, bbox: { left, top, width, height } }
}

export interface AlignResult {
  path: string
  warnings: string[]
  contentHeight: number
}

/**
 * 统一帧对齐：
 * 1. 以各帧内容高度中位数为基准做等比缩放（限制在 0.7~1.4 倍，避免过度拉伸）
 * 2. 水平居中、底部对齐到统一基线
 * 3. 偏差超过阈值的帧返回 warning，供 UI 标红提示重生成
 */
export async function alignFrames(
  files: string[],
  opts: {
    canvasWidth: number
    canvasHeight: number
    bottomPadding?: number
    normalizeScale?: boolean
    heightTolerance?: number
  }
): Promise<AlignResult[]> {
  const bottomPadding = opts.bottomPadding ?? 2
  const heightTolerance = opts.heightTolerance ?? 0.15
  const infos = []

  for (const file of files) {
    const img = await readRgba(file)
    const bbox = alphaBBox(img)
    infos.push({ file, img, bbox })
  }

  const heights = infos.map((i) => i.bbox?.height ?? 0).filter((h) => h > 0)
  const medianHeight = median(heights) || opts.canvasHeight

  const results: AlignResult[] = []
  for (const info of infos) {
    const warnings: string[] = []
    if (!info.bbox) {
      warnings.push('未检测到主体（图片全透明），请重新生成')
      const blank = await sharp({
        create: {
          width: opts.canvasWidth,
          height: opts.canvasHeight,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        }
      })
        .png()
        .toBuffer()
      const out = info.file.replace(/\.png$/i, '-aligned.png')
      await sharp(blank).toFile(out)
      results.push({ path: out, warnings, contentHeight: 0 })
      continue
    }

    const dev = Math.abs(info.bbox.height - medianHeight) / medianHeight
    if (dev > heightTolerance) {
      warnings.push(`主体高度偏差 ${(dev * 100).toFixed(0)}%，可能与其它帧不一致`)
    }

    let scale = 1
    if (opts.normalizeScale !== false) {
      scale = Math.min(1.4, Math.max(0.7, medianHeight / info.bbox.height))
    }

    const targetW = Math.max(1, Math.round(info.bbox.width * scale))
    const targetH = Math.max(1, Math.round(info.bbox.height * scale))
    const scaleX = targetW / info.bbox.width
    const scaleY = targetH / info.bbox.height

    // 裁剪主体并按比例缩放
    const contentBuf = await sharp(info.file)
      .ensureAlpha()
      .extract({
        left: info.bbox.left,
        top: info.bbox.top,
        width: info.bbox.width,
        height: info.bbox.height
      })
      .resize(targetW, targetH, { fit: 'fill' })
      .png()
      .toBuffer()
    void scaleX
    void scaleY

    const left = Math.round(opts.canvasWidth / 2 - targetW / 2)
    const top = opts.canvasHeight - bottomPadding - targetH

    if (left < 0 || top < 0) {
      warnings.push('主体超出画布，已自动缩小。建议增大画布尺寸或降低动作幅度')
    }
    const safeLeft = Math.max(0, left)
    const safeTop = Math.max(0, top)

    const out = info.file.replace(/\.png$/i, '-aligned.png')
    await sharp({
      create: {
        width: opts.canvasWidth,
        height: opts.canvasHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite([{ input: contentBuf, left: safeLeft, top: safeTop }])
      .png()
      .toFile(out)

    results.push({ path: out, warnings, contentHeight: targetH })
  }

  return results
}

/** 横向拼接图集 */
export async function composeAtlas(
  files: string[],
  cellWidth: number,
  cellHeight: number,
  outPath: string
): Promise<string> {
  const canvas = sharp({
    create: {
      width: cellWidth * files.length,
      height: cellHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })

  const composites = files.map((file, i) => ({
    input: file,
    left: i * cellWidth,
    top: 0
  }))

  await canvas.composite(composites).png().toFile(outPath)
  return outPath
}

/** 瓦片无缝性评分：比较左右、上下边缘的像素差异 */
export async function seamlessScore(file: string): Promise<number> {
  const img = await readRgba(file)
  const { data, width, height } = img
  let diff = 0
  let count = 0
  for (let y = 0; y < height; y++) {
    const l = (y * width) * 4
    const r = (y * width + width - 1) * 4
    diff += colorDistance(data, l, r)
    count++
  }
  for (let x = 0; x < width; x++) {
    const t = x * 4
    const b = ((height - 1) * width + x) * 4
    diff += colorDistance(data, t, b)
    count++
  }
  const avg = diff / Math.max(1, count)
  // 平均色差 0 → 1 分，60 → 0 分
  return Math.max(0, Math.min(1, 1 - avg / 60))
}

function colorDistance(buf: Buffer, i: number, j: number): number {
  const dr = buf[i] - buf[j]
  const dg = buf[i + 1] - buf[j + 1]
  const db = buf[i + 2] - buf[j + 2]
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
