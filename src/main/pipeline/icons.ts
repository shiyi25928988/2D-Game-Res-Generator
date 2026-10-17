import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import type { IconJobPayload, IconJobResult, JobProgressEvent } from '@shared/types'
import type { ImageProvider } from '../providers/types'
import { readRgba, removeBackgroundInPlace, writeRgba, cropToContent } from '../image/process'
import { jobTempDir, ensureDir } from '../util/files'

export async function runIconJob(
  jobId: string,
  payload: IconJobPayload,
  provider: ImageProvider,
  emit: (e: JobProgressEvent) => void,
  signal: AbortSignal
): Promise<IconJobResult> {
  const total = Math.max(1, payload.count)
  const dir = jobTempDir(jobId)
  await ensureDir(dir)
  const outDir = join(payload.outputDir, 'icons')
  await mkdir(outDir, { recursive: true })

  const files: string[] = []
  for (let i = 0; i < total; i++) {
    if (signal.aborted) throw new Error('已取消')

    emit({
      jobId,
      stage: 'generating-frames',
      progress: i / total,
      message: `生成第 ${i + 1}/${total} 个图标…`,
      frameIndex: i,
      totalFrames: total
    })

    const res = await provider.generate(
      {
        prompt: `${payload.prompt}, game item icon, single centered object, clean edges, no text`,
        negativePrompt: payload.negativePrompt ?? 'text, watermark, frame, multiple objects',
        width: payload.size,
        height: payload.size,
        seed: payload.seed >= 0 ? payload.seed + i : 'random',
        steps: payload.steps,
        cfgScale: payload.cfgScale
      },
      (p) =>
        emit({
          jobId,
          stage: 'generating-frames',
          progress: (i + p) / total,
          message: `第 ${i + 1}/${total} 个图标 ${(p * 100).toFixed(0)}%`,
          frameIndex: i,
          totalFrames: total
        }),
      signal
    )

    let path = res.images[0].path
    if (payload.removeBackground) {
      const img = await readRgba(path)
      removeBackgroundInPlace(img, 30)
      const out = path.replace(/\.png$/i, '-nobg.png')
      await writeRgba(img, out)
      path = out
    }

    const cropped = await cropToContent(path, 4)
    const out = join(outDir, `${payload.prefix}_${String(i).padStart(2, '0')}.png`)
    await sharp(cropped.path)
      .resize(payload.size, payload.size, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toFile(out)
    files.push(out)
  }

  emit({ jobId, stage: 'done', progress: 1, message: `已生成 ${files.length} 个图标` })
  return { jobId, files }
}
