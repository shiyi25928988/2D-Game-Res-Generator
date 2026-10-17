import type {
  Capability,
  ConnectionTestResult,
  GenerateRequest,
  GenerateResult,
  ProviderConfig
} from '@shared/types'
import { fileToBase64, jobTempDir, saveBase64Image } from '../util/files'
import { explainConnectionError, httpJson, joinUrl, sleep, type ImageProvider } from './types'

interface WebuiImageResponse {
  images: string[]
  info?: string
  parameters?: Record<string, unknown>
}

interface WebuiModel {
  title: string
  model_name: string
}

interface WebuiOptions {
  controlnetModel?: string
  sampler?: string
  username?: string
  password?: string
  /** 生成超时（秒），本地低配显卡可能需要更久 */
  timeoutSec?: number
}

/**
 * AUTOMATIC1111 / Forge 的 /sdapi/v1 接口。
 * 启动需带 --api；跨域访问需 --cors-allow-origins。
 */
export class SdWebuiProvider implements ImageProvider {
  readonly capabilities: Capability[]

  constructor(
    readonly config: ProviderConfig,
    private readonly apiKey?: string,
    private readonly jobId = 'adhoc'
  ) {
    const opts = (config.options ?? {}) as WebuiOptions
    this.capabilities = ['txt2img', 'img2img', ...(opts.controlnetModel ? (['controlnet'] as const) : [])]
  }

  private get opts(): WebuiOptions {
    return (this.config.options ?? {}) as WebuiOptions
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {}
    if (this.opts.username) {
      const token = Buffer.from(`${this.opts.username}:${this.opts.password ?? ''}`).toString('base64')
      h.Authorization = `Basic ${token}`
    } else if (this.apiKey) {
      h.Authorization = `Bearer ${this.apiKey}`
    }
    return h
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const started = Date.now()
    try {
      const models = await httpJson<WebuiModel[]>(joinUrl(this.config.baseUrl, '/sdapi/v1/sd-models'), {
        method: 'GET',
        headers: this.headers()
      }, 8000)
      return {
        ok: true,
        message: `连接成功，发现 ${models.length} 个模型`,
        models: models.map((m) => m.title ?? m.model_name),
        capabilities: this.capabilities,
        latencyMs: Date.now() - started
      }
    } catch (err) {
      return {
        ok: false,
        message: explainConnectionError(err, this.config.baseUrl),
        capabilities: this.capabilities
      }
    }
  }

  async generate(
    req: GenerateRequest,
    onProgress?: (p: number) => void,
    signal?: AbortSignal
  ): Promise<GenerateResult> {
    const started = Date.now()
    const isImg2Img = Boolean(req.initImagePath)
    const endpoint = isImg2Img ? '/sdapi/v1/img2img' : '/sdapi/v1/txt2img'

    const body: Record<string, unknown> = {
      prompt: req.prompt,
      negative_prompt: req.negativePrompt ?? '',
      width: req.width,
      height: req.height,
      seed: req.seed === 'random' ? -1 : req.seed,
      steps: req.steps ?? 24,
      cfg_scale: req.cfgScale ?? 7,
      sampler_name: req.sampler ?? this.opts.sampler ?? 'DPM++ 2M Karras',
      batch_size: req.batchSize ?? 1,
      n_iter: 1,
      send_images: true,
      save_images: false
    }

    if (this.config.model) {
      body.override_settings = { sd_model_checkpoint: this.config.model }
      body.override_settings_restore_afterwards = false
    }

    if (isImg2Img && req.initImagePath) {
      body.init_images = [await fileToBase64(req.initImagePath)]
      body.denoising_strength = req.denoise ?? 0.55
    }

    const cn = this.opts.controlnetModel
    if (req.controlnet && cn) {
      body.alwayson_scripts = {
        ControlNet: {
          args: [
            {
              enabled: true,
              image: await fileToBase64(req.controlnet.imagePath),
              module: req.controlnet.module,
              model: cn,
              weight: req.controlnet.weight,
              control_mode: 0,
              resize_mode: 1,
              guidance_end: 1
            }
          ]
        }
      }
    }

    // 轮询进度，避免 UI 长时间无反馈
    let polling = true
    const poll = (async () => {
      while (polling) {
        await sleep(900)
        if (!polling) break
        try {
          const p = await httpJson<{ progress: number }>(
            joinUrl(this.config.baseUrl, '/sdapi/v1/progress'),
            { method: 'GET', headers: this.headers() },
            4000
          )
          onProgress?.(Math.min(0.95, Math.max(0, p.progress ?? 0)))
        } catch {
          // 进度接口失败不影响主流程
        }
      }
    })()

    let res: WebuiImageResponse
    try {
      res = await httpJson<WebuiImageResponse>(
        joinUrl(this.config.baseUrl, endpoint),
        {
          method: 'POST',
          body: JSON.stringify(body),
          headers: this.headers(),
          signal
        },
        (this.opts.timeoutSec ?? 600) * 1000
      )
    } catch (err) {
      throw new Error(explainConnectionError(err, this.config.baseUrl))
    } finally {
      polling = false
      await poll
    }

    if (!res.images?.length) throw new Error('生图服务未返回图片，请检查模型是否已加载')

    const dir = jobTempDir(this.jobId)
    const info = res.info ? (JSON.parse(res.info) as { seed?: number }) : undefined
    const baseSeed = typeof info?.seed === 'number' ? info.seed : req.seed === 'random' ? -1 : req.seed

    const images: GenerateResult['images'] = []
    for (let i = 0; i < res.images.length; i++) {
      const path = await saveBase64Image(res.images[i], dir, 'webui')
      images.push({
        path,
        seed: baseSeed >= 0 ? baseSeed + i : -1,
        width: req.width,
        height: req.height
      })
    }
    onProgress?.(1)

    return {
      images,
      meta: {
        providerId: this.config.id,
        providerType: 'sd-webui',
        model: this.config.model,
        sampler: body.sampler_name as string,
        durationMs: Date.now() - started,
        raw: res.parameters
      }
    }
  }
}
