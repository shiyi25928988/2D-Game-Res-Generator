/**
 * 图像管线自检（不依赖 Electron 运行时）。
 * 用合成图验证：去底 → 对齐 → 拼图 → Godot 导出。
 *
 * 运行：npm run selftest
 */
import sharp from 'sharp'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readRgba,
  removeBackgroundInPlace,
  writeRgba,
  cropToContent,
  alignFrames,
  composeAtlas,
  alphaBBox
} from '../src/main/image/process'
import { exportGodot } from '../src/main/exporter/godot'

let failures = 0

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.log(`  ✗ ${name} ${detail}`)
  }
}

/** 造一张白底、主体位置略有差异的帧，模拟生成结果 */
async function makeFrame(path: string, offsetX: number, offsetY: number, radius: number): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">
    <rect width="128" height="128" fill="#ffffff"/>
    <circle cx="${64 + offsetX}" cy="${64 + offsetY}" r="${radius}" fill="#3355cc"/>
    <rect x="${64 + offsetX - 6}" y="${64 + offsetY + radius - 6}" width="12" height="20" fill="#223388"/>
  </svg>`
  await sharp(Buffer.from(svg)).png().toFile(path)
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'resgen-selftest-'))
  const framePaths: string[] = []
  const offsets = [
    [0, 0, 26],
    [3, -4, 28],
    [-2, 5, 24],
    [1, 2, 27]
  ]
  for (let i = 0; i < offsets.length; i++) {
    const p = join(dir, `frame_${i}.png`)
    await makeFrame(p, offsets[i][0], offsets[i][1], offsets[i][2])
    framePaths.push(p)
  }

  console.log('\n[1] 去底')
  const cleaned: string[] = []
  for (const p of framePaths) {
    const img = await readRgba(p)
    removeBackgroundInPlace(img, 32)
    const out = p.replace('.png', '-nobg.png')
    await writeRgba(img, out)
    cleaned.push(out)
  }
  const first = await readRgba(cleaned[0])
  const cornerAlpha = first.data[3]
  const centerIndex = ((64 * first.width) + 64) * 4 + 3
  check('四角背景变透明', cornerAlpha === 0, `alpha=${cornerAlpha}`)
  check('主体保持不透明', first.data[centerIndex] > 200, `alpha=${first.data[centerIndex]}`)
  const bbox = alphaBBox(first)
  check('能检测到主体包围盒', Boolean(bbox && bbox.width > 20 && bbox.height > 20))

  console.log('\n[2] 裁切与对齐')
  const cropped: string[] = []
  for (const p of cleaned) {
    const r = await cropToContent(p, 2)
    cropped.push(r.path)
  }
  const aligned = await alignFrames(cropped, {
    canvasWidth: 128,
    canvasHeight: 128,
    bottomPadding: 2,
    normalizeScale: true
  })
  check('每帧输出统一画布', aligned.length === 4)
  const metas = await Promise.all(aligned.map((a) => sharp(a.path).metadata()))
  check(
    '画布尺寸一致 128x128',
    metas.every((m) => m.width === 128 && m.height === 128),
    JSON.stringify(metas.map((m) => `${m.width}x${m.height}`))
  )
  const bottoms = await Promise.all(
    aligned.map(async (a) => {
      const img = await readRgba(a.path)
      return alphaBBox(img)
    })
  )
  const baselineDiffs = bottoms.map((b) => (b ? 128 - (b.top + b.height) : -1))
  check(
    '脚底基线一致（偏差 ≤ 2px）',
    baselineDiffs.every((d) => Math.abs(d - baselineDiffs[0]) <= 2),
    JSON.stringify(baselineDiffs)
  )

  console.log('\n[3] 拼接图集')
  const atlas = join(dir, 'walk.png')
  await composeAtlas(
    aligned.map((a) => a.path),
    128,
    128,
    atlas
  )
  const atlasMeta = await sharp(atlas).metadata()
  check('图集宽度 = 帧数 × 画布宽', atlasMeta.width === 512 && atlasMeta.height === 128, `${atlasMeta.width}x${atlasMeta.height}`)

  console.log('\n[4] Godot 导出')
  const godotRoot = join(dir, 'godot-project')
  await mkdir(godotRoot, { recursive: true })
  await writeFile(join(godotRoot, 'project.godot'), 'config_version=5\n')
  const res = await exportGodot({
    atlasPath: atlas,
    actionName: 'walk',
    characterName: 'hero',
    fps: 12,
    loop: true,
    frameWidth: 128,
    frameHeight: 128,
    frameCount: 4,
    godotProjectRoot: godotRoot,
    exportJson: true,
    meta: { selftest: true }
  })
  check('导出 3 个文件（png/tres/json）', res.files.length === 3, JSON.stringify(res.files))
  check('无 project.godot 警告', res.warnings.length === 0, res.warnings.join(';'))

  const tres = await readFile(join(godotRoot, 'assets', 'generated', 'hero', 'walk.tres'), 'utf-8')
  check('资源类型为 SpriteFrames', tres.includes('type="SpriteFrames"'))
  check('引用 png 图集', tres.includes('res://assets/generated/hero/walk.png'))
  check('包含 4 个 AtlasTexture', (tres.match(/type="AtlasTexture"/g) ?? []).length === 4)
  check('动画名与帧率正确', tres.includes('&"walk"') && tres.includes('"speed": 12.0'))
  check('循环标记正确', tres.includes('"loop": true'))
  check('帧区域位置正确', tres.includes('Rect2(384, 0, 128, 128)'))

  const json = JSON.parse(
    await readFile(join(godotRoot, 'assets', 'generated', 'hero', 'walk.json'), 'utf-8')
  ) as { frames: unknown[]; meta: { fps: number } }
  check('图集 JSON 帧数正确', json.frames.length === 4 && json.meta.fps === 12)

  console.log('\n' + (failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`))
  console.log(`临时目录：${dir}`)
  if (failures === 0) await rm(dir, { recursive: true, force: true })
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
