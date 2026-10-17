/**
 * 端到端测试：起一个模拟的 Stable Diffusion WebUI 服务，
 * 跑通「参考母版 → 逐帧生成 → 去底 → 对齐 → 拼图 → Godot 导出」全链路。
 *
 * 不依赖真实显卡与服务，用于验证适配器契约与管线逻辑。
 * 运行：npm run e2e
 */
import http from 'node:http'
import sharp from 'sharp'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createProvider } from '../src/main/providers'
import { runSpriteJob } from '../src/main/pipeline/sprite'
import { exportGodot } from '../src/main/exporter/godot'
import type { JobProgressEvent, SpriteJobPayload } from '../src/shared/types'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.log(`  ✗ ${name} ${detail}`)
  }
}

/** 生成一张白底、带主体的假角色图，seed 决定细微抖动 */
async function fakeCharacter(seed: number, size = 128, controlnet = false): Promise<Buffer> {
  const jitter = (seed % 5) - 2
  const headX = size / 2 + jitter * 0.6
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <rect width="${size}" height="${size}" fill="#ffffff"/>
    <circle cx="${headX}" cy="${size * 0.26}" r="${size * 0.11}" fill="#e8b98a"/>
    <rect x="${headX - size * 0.09}" y="${size * 0.36}" width="${size * 0.18}" height="${size * 0.3}" rx="6" fill="#3b5bdb"/>
    <rect x="${headX - size * 0.13}" y="${size * 0.64}" width="${size * 0.09}" height="${size * 0.26}" fill="#2b3f9e"/>
    <rect x="${headX + size * 0.04}" y="${size * 0.64}" width="${size * 0.09}" height="${size * 0.26}" fill="#2b3f9e"/>
    <rect x="${headX - size * 0.2}" y="${size * 0.38}" width="${size * 0.1}" height="${size * 0.22}" rx="4" fill="#3b5bdb"/>
    <rect x="${headX + size * 0.1}" y="${size * 0.38}" width="${size * 0.1}" height="${size * 0.22}" rx="4" fill="#3b5bdb"/>
    <rect x="${headX - size * 0.16}" y="${size * 0.9}" width="${size * 0.14}" height="${size * 0.04}" fill="#222222"/>
    <rect x="${headX + size * 0.02}" y="${size * 0.9}" width="${size * 0.14}" height="${size * 0.04}" fill="#222222"/>
    ${controlnet ? `<text x="6" y="14" font-size="9" fill="#888">pose</text>` : ''}
  </svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
  })
}

async function startMockServer(): Promise<{ url: string; close: () => Promise<void>; calls: string[] }> {
  const calls: string[] = []

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/'
    calls.push(url)
    res.setHeader('Content-Type', 'application/json')

    if (url.startsWith('/sdapi/v1/sd-models')) {
      res.end(JSON.stringify([{ title: 'mock-v1.safetensors', model_name: 'mock-v1' }]))
      return
    }
    if (url.startsWith('/sdapi/v1/options')) {
      res.end(JSON.stringify({ sd_model_checkpoint: 'mock-v1.safetensors' }))
      return
    }
    if (url.startsWith('/sdapi/v1/progress')) {
      res.end(JSON.stringify({ progress: 0.62, state: {} }))
      return
    }
    if (url.startsWith('/sdapi/v1/txt2img') || url.startsWith('/sdapi/v1/img2img')) {
      const body = JSON.parse((await readBody(req)) || '{}') as {
        seed?: number
        width?: number
        height?: number
        alwayson_scripts?: unknown
      }
      const seed = typeof body.seed === 'number' && body.seed >= 0 ? body.seed : 1234
      const size = body.width ?? 128
      const hasControlNet = Boolean(body.alwayson_scripts)
      const png = await fakeCharacter(seed, size, hasControlNet)
      res.end(
        JSON.stringify({
          images: [png.toString('base64')],
          info: JSON.stringify({ seed, controlnet: hasControlNet }),
          parameters: { seed }
        })
      )
      return
    }

    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found' }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function main(): Promise<void> {
  const mock = await startMockServer()
  const workDir = await mkdtemp(join(tmpdir(), 'resgen-e2e-'))
  process.env.RESGEN_TEMP_DIR = join(workDir, 'tmp')

  console.log('\n[1] Provider 适配器')
  const provider = createProvider({
    id: 'mock-sd',
    type: 'sd-webui',
    name: '模拟 SD',
    enabled: true,
    baseUrl: mock.url,
    model: 'mock-v1.safetensors',
    options: { controlnetModel: 'mock-openpose', sampler: 'Euler a' }
  })

  const conn = await provider.testConnection()
  check('连接测试成功', conn.ok, conn.message)
  check('返回模型列表', (conn.models ?? []).length === 1)
  check('声明 controlnet 能力', provider.capabilities.includes('controlnet'))

  console.log('\n[2] 精灵动画管线')
  const payload: SpriteJobPayload = {
    projectId: 'e2e',
    providerId: 'mock-sd',
    stylePrompt: 'pixel art knight',
    negativePrompt: 'blurry',
    canvasWidth: 128,
    canvasHeight: 128,
    removeBackground: true,
    autoAlign: true,
    action: { name: 'walk', frames: 4, fps: 12, loop: true, intensity: 'medium' },
    seed: 42,
    steps: 20,
    cfgScale: 7,
    outputDir: join(workDir, 'out'),
    characterName: 'hero'
  }

  const events: JobProgressEvent[] = []
  const result = await runSpriteJob(
    'e2e-job',
    payload,
    provider,
    (e) => events.push(e),
    new AbortController().signal
  )

  check('生成 4 帧', result.frames.length === 4)
  check('判定一致性等级 A', result.providerLevel === 'A', result.providerLevel)
  check('产生了进度事件', events.length > 3, String(events.length))
  check(
    '进度单调递增',
    events.every((e, i) => i === 0 || e.progress >= events[i - 1].progress - 1e-6)
  )
  check('调用了 txt2img 生成母版', mock.calls.some((c) => c.includes('txt2img')))
  check('调用了 img2img 生成帧', mock.calls.filter((c) => c.includes('img2img')).length >= 4)

  const atlasStat = await stat(result.atlasPath).catch(() => null)
  check('图集文件已生成', Boolean(atlasStat?.size))
  const atlasMeta = await sharp(result.atlasPath).metadata()
  check('图集尺寸 512×128', atlasMeta.width === 512 && atlasMeta.height === 128, `${atlasMeta.width}x${atlasMeta.height}`)

  const firstFrame = await sharp(result.frames[0].path).metadata()
  check(
    '单帧尺寸为 128×128 且带透明通道',
    firstFrame.width === 128 && firstFrame.height === 128,
    `${firstFrame.width}x${firstFrame.height} ${firstFrame.hasAlpha}`
  )

  const frameStats = await Promise.all(result.frames.map((f) => stat(f.path).catch(() => null)))
  check('所有帧文件存在', frameStats.every((s) => Boolean(s?.size)))

  console.log('\n[3] Godot 导出')
  const godotRoot = join(workDir, 'godot')
  await mkdir(godotRoot, { recursive: true })
  await writeFile(join(godotRoot, 'project.godot'), 'config_version=5\n')
  const exported = await exportGodot({
    atlasPath: result.atlasPath,
    actionName: 'walk',
    characterName: 'hero',
    fps: 12,
    loop: true,
    frameWidth: 128,
    frameHeight: 128,
    frameCount: 4,
    godotProjectRoot: godotRoot,
    exportJson: true
  })
  check('导出成功且无警告', exported.files.length === 3 && exported.warnings.length === 0)
  const tres = await readFile(join(godotRoot, 'assets', 'generated', 'hero', 'walk.tres'), 'utf-8')
  check('SpriteFrames 动画名为 walk', tres.includes('&"walk"'))
  check('导出 JSON 含生成参数', (await readFile(join(godotRoot, 'assets', 'generated', 'hero', 'walk.json'), 'utf-8')).includes('"frames"'))

  console.log('\n' + (failures === 0 ? '端到端全部通过 ✅' : `${failures} 项失败 ❌`))
  console.log(`工作目录：${workDir}`)

  await mock.close()
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
