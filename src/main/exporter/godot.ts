import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { ExportResult } from '@shared/types'

export interface GodotExportOptions {
  atlasPath: string
  actionName: string
  characterName: string
  fps: number
  loop: boolean
  frameWidth: number
  frameHeight: number
  frameCount: number
  godotProjectRoot: string
  exportJson?: boolean
  meta?: Record<string, unknown>
}

/** 生成 Godot 4 的 SpriteFrames 资源文本 */
export function buildSpriteFramesTres(opts: {
  resPath: string
  actionName: string
  fps: number
  loop: boolean
  frameWidth: number
  frameHeight: number
  frameCount: number
}): string {
  const { resPath, actionName, fps, loop, frameWidth, frameHeight, frameCount } = opts
  const loadSteps = frameCount + 2

  const lines: string[] = []
  lines.push(`[gd_resource type="SpriteFrames" load_steps=${loadSteps} format=3]`)
  lines.push('')
  lines.push(`[ext_resource type="Texture2D" path="${resPath}" id="1_atlas"]`)
  lines.push('')

  for (let i = 0; i < frameCount; i++) {
    lines.push(`[sub_resource type="AtlasTexture" id="AtlasTexture_${i}"]`)
    lines.push('atlas = ExtResource("1_atlas")')
    lines.push(`region = Rect2(${i * frameWidth}, 0, ${frameWidth}, ${frameHeight})`)
    lines.push('')
  }

  const frames = Array.from({ length: frameCount }, (_, i) => {
    return `{\n"duration": 1.0,\n"texture": SubResource("AtlasTexture_${i}")\n}`
  }).join(', ')

  lines.push('[resource]')
  lines.push(`animations = [{
"frames": [${frames}],
"loop": ${loop ? 'true' : 'false'},
"name": &"${actionName}",
"speed": ${fps.toFixed(1)}
}]`)
  lines.push('')

  return lines.join('\n')
}

export async function exportGodot(opts: GodotExportOptions): Promise<ExportResult> {
  const warnings: string[] = []
  const files: string[] = []

  const outDir = join(opts.godotProjectRoot, 'assets', 'generated', opts.characterName)
  await mkdir(outDir, { recursive: true })

  const pngName = `${opts.actionName}.png`
  const pngPath = join(outDir, pngName)
  await copyFile(opts.atlasPath, pngPath)
  files.push(pngPath)

  const relPath = relative(opts.godotProjectRoot, pngPath).split('\\').join('/')
  const tres = buildSpriteFramesTres({
    resPath: `res://${relPath}`,
    actionName: opts.actionName,
    fps: opts.fps,
    loop: opts.loop,
    frameWidth: opts.frameWidth,
    frameHeight: opts.frameHeight,
    frameCount: opts.frameCount
  })

  const tresPath = join(outDir, `${opts.actionName}.tres`)
  await writeFile(tresPath, tres, 'utf-8')
  files.push(tresPath)

  if (opts.exportJson) {
    const jsonPath = join(outDir, `${opts.actionName}.json`)
    await writeFile(
      jsonPath,
      JSON.stringify(
        {
          frames: Array.from({ length: opts.frameCount }, (_, i) => ({
            filename: `${opts.actionName}_${i}`,
            frame: { x: i * opts.frameWidth, y: 0, w: opts.frameWidth, h: opts.frameHeight },
            duration: 1 / Math.max(1, opts.fps)
          })),
          meta: {
            image: pngName,
            size: { w: opts.frameWidth * opts.frameCount, h: opts.frameHeight },
            scale: '1',
            action: opts.actionName,
            fps: opts.fps,
            loop: opts.loop,
            ...(opts.meta ?? {})
          }
        },
        null,
        2
      ),
      'utf-8'
    )
    files.push(jsonPath)
  }

  if (!existsSync(join(opts.godotProjectRoot, 'project.godot'))) {
    warnings.push('目标目录下未发现 project.godot，请确认选择的是 Godot 项目根目录')
  }

  return { files, warnings }
}
