import { mkdir, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  JobProgressEvent,
  ProviderConfig,
  SpriteJobPayload,
  SpriteJobResult,
  SpriteFrameResult
} from '@shared/types'
import type { ImageProvider } from '../providers/types'
import { readRgba, removeBackgroundInPlace, writeRgba, cropToContent, alignFrames, composeAtlas } from '../image/process'
import { renderPosePng } from '../image/pose'
import { jobTempDir, ensureDir } from '../util/files'

const DENOISE_BY_INTENSITY = {
  low: 0.38,
  medium: 0.52,
  high: 0.62
} as const

/** 根据 Provider 能力判断动画帧一致性等级 */
export function providerLevel(caps: string[]): 'A' | 'B' | 'C' {
  if (caps.includes('img2img') && caps.includes('controlnet')) return 'A'
  if (caps.includes('img2img')) return 'B'
  return 'C'
}

const FRAME_PROMPT_SUFFIX =
  'full body character sprite, single character, centered, clean silhouette, game asset, side-neutral view'

export async function runSpriteJob(
  jobId: string,
  payload: SpriteJobPayload,
  provider: ImageProvider,
  emit: (e: JobProgressEvent) => void,
  signal: AbortSignal
): Promise<SpriteJobResult> {
  const total = Math.max(1, payload.action.frames)
  const warnings: string[] = []
  const level = providerLevel(provider.capabilities)
  const dir = jobTempDir(jobId)
  const rawDir = join(dir, 'raw')
  const poseDir = join(dir, 'pose')
  await ensureDir(rawDir)
  await ensureDir(poseDir)

  if (level === 'C') {
    warnings.push(
      '当前生图服务不支持 img2img，动画帧之间会有明显差异。建议改用本地 Stable Diffusion 生成动画。'
    )
  }

  const report = (
    stage: JobProgressEvent['stage'],
    progress: number,
    message: string,
    frameIndex?: number
  ): void => emit({ jobId, stage, progress, message, frameIndex, totalFrames: total })

  // ---------- 1. 风格参考母版 ----------
  report('generating-reference', 0.02, '准备风格参考母版…')
  let referencePath = payload.referenceImagePath

  if (!referencePath) {
    const refRes = await provider.generate(
      {
        prompt: `${payload.stylePrompt}, ${payload.characterName}, neutral standing pose, ${FRAME_PROMPT_SUFFIX}`,
        negativePrompt: payload.negativePrompt,
        width: payload.canvasWidth,
        height: payload.canvasHeight,
        seed: payload.seed >= 0 ? payload.seed : 'random',
        steps: payload.steps,
        cfgScale: payload.cfgScale,
        sampler: payload.sampler
      },
      (p) => report('generating-reference', 0.02 + p * 0.08, `生成参考母版 ${(p * 100).toFixed(0)}%`),
      signal
    )
    referencePath = refRes.images[0].path
    await copyFile(referencePath, join(dir, 'reference.png')).catch(() => undefined)
  }
  report('generating-reference', 0.1, '参考母版就绪')

  // ---------- 2. 逐帧生成 ----------
  const rawFrames: string[] = []
  for (let i = 0; i < total; i++) {
    if (signal.aborted) throw new Error('已取消')

    const frameStart = 0.1 + (i / total) * 0.65
    report('generating-frames', frameStart, `生成第 ${i + 1}/${total} 帧…`, i)

    const posePath =
      level === 'A'
        ? await renderPosePng(
            payload.action.name,
            i,
            total,
            payload.canvasWidth,
            payload.canvasHeight,
            join(poseDir, `pose_${String(i).padStart(2, '0')}.png`)
          )
        : undefined

    const res = await provider.generate(
      {
        prompt: `${payload.stylePrompt}, ${payload.characterName}, ${payload.action.name} animation frame ${i + 1} of ${total}, ${FRAME_PROMPT_SUFFIX}`,
        negativePrompt: payload.negativePrompt,
        width: payload.canvasWidth,
        height: payload.canvasHeight,
        seed: payload.seed >= 0 ? payload.seed + i : 'random',
        steps: payload.steps,
        cfgScale: payload.cfgScale,
        sampler: payload.sampler,
        // C 级服务不支持 img2img，强行传参考图会被后端拒绝
        initImagePath: level === 'C' ? undefined : referencePath,
        denoise: DENOISE_BY_INTENSITY[payload.action.intensity],
        controlnet:
          level === 'A' && posePath
            ? { module: 'openpose', imagePath: posePath, weight: 0.85 }
            : undefined
      },
      (p) =>
        report(
          'generating-frames',
          frameStart + (p / total) * 0.65,
          `第 ${i + 1}/${total} 帧 ${(p * 100).toFixed(0)}%`,
          i
        ),
      signal
    )

    rawFrames.push(res.images[0].path)
    report('generating-frames', 0.1 + ((i + 1) / total) * 0.65, `第 ${i + 1}/${total} 帧完成`, i)
  }

  // ---------- 3. 后处理：去底 + 裁切 ----------
  report('postprocessing', 0.78, '去底与裁切…')
  const cleaned: string[] = []
  for (let i = 0; i < rawFrames.length; i++) {
    if (signal.aborted) throw new Error('已取消')
    let path = rawFrames[i]

    if (payload.removeBackground) {
      const img = await readRgba(path)
      removeBackgroundInPlace(img, 32)
      const out = path.replace(/\.png$/i, '-nobg.png')
      await writeRgba(img, out)
      path = out
    }
    const cropped = await cropToContent(path, 2)
    cleaned.push(cropped.path)
    report('postprocessing', 0.78 + ((i + 1) / cleaned.length) * 0.06, `处理第 ${i + 1} 帧`)
  }

  // ---------- 4. 对齐 + 校验 ----------
  report('aligning', 0.86, '统一画布与基线对齐…')
  const aligned = await alignFrames(cleaned, {
    canvasWidth: payload.canvasWidth,
    canvasHeight: payload.canvasHeight,
    bottomPadding: 2,
    normalizeScale: true
  })

  const frames: SpriteFrameResult[] = aligned.map((a, i) => {
    const status = a.warnings.length > 0 ? 'needs-review' : 'ok'
    return {
      index: i,
      path: a.path,
      seed: payload.seed >= 0 ? payload.seed + i : -1,
      status,
      warnings: a.warnings
    }
  })

  const reviewCount = frames.filter((f) => f.status === 'needs-review').length
  if (reviewCount > 0) {
    warnings.push(`${reviewCount} 帧的一致性校验未通过，已在预览中标红，建议单帧重生成`)
  }

  // ---------- 5. 输出 ----------
  report('exporting', 0.93, '拼接图集…')
  const outDir = join(payload.outputDir, payload.characterName)
  await mkdir(outDir, { recursive: true })
  const atlasPath = join(outDir, `${payload.action.name}.png`)
  await composeAtlas(
    frames.map((f) => f.path),
    payload.canvasWidth,
    payload.canvasHeight,
    atlasPath
  )

  // 同时保留独立帧，便于用户单帧替换
  const framesDir = join(outDir, 'frames')
  await mkdir(framesDir, { recursive: true })
  for (const f of frames) {
    const name = `${payload.action.name}_${String(f.index).padStart(2, '0')}.png`
    await copyFile(f.path, join(framesDir, name)).catch(() => undefined)
  }

  await writeFile(
    join(outDir, `${payload.action.name}.meta.json`),
    JSON.stringify(
      {
        character: payload.characterName,
        action: payload.action,
        provider: { id: payload.providerId, level },
        prompt: payload.stylePrompt,
        negativePrompt: payload.negativePrompt,
        canvas: { width: payload.canvasWidth, height: payload.canvasHeight },
        seed: payload.seed,
        steps: payload.steps,
        cfgScale: payload.cfgScale,
        sampler: payload.sampler,
        removeBackground: payload.removeBackground,
        autoAlign: payload.autoAlign,
        generatedAt: new Date().toISOString()
      },
      null,
      2
    ),
    'utf-8'
  )

  report('done', 1, '完成')
  return {
    jobId,
    characterName: payload.characterName,
    action: payload.action,
    frames,
    atlasPath,
    canvasWidth: payload.canvasWidth,
    canvasHeight: payload.canvasHeight,
    providerLevel: level,
    warnings
  }
}

export function describeProvider(provider: ImageProvider): ProviderConfig {
  return provider.config
}
