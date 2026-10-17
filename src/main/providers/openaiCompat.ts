import type {
  Capability,
  ConnectionTestResult,
  GenerateRequest,
  GenerateResult,
  ProviderConfig
} from '@shared/types'
import { jobTempDir, saveBase64Image, saveBufferImage } from '../util/files'
import {
  explainConnectionError,
  fetchBinary,
  httpJson,
  joinUrl,
  sleep,
  type ImageProvider
} from './types'

interface OpenAiOptions {
  /** 部分中转支持 img2img（/images/edits），默认关闭 */
  enableImg2Img?: boolean
  timeoutSec?: number
}

interface ImagesResponse {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>
  error?: { message?: string }
}

/** OpenAI 兼容接口（含各类中转服务） */
export class OpenAiCompatProvider implements ImageProvider {
  readonly capabilities: Capability[]

  constructor(
    readonly config: ProviderConfig,
    private readonly apiKey?: string,
    private readonly jobId = 'adhoc'
  ) {
    const opts = (config.options ?? {}) as OpenAiOptions
    this.capabilities = opts.enableImg2Img ? ['txt2img', 'img2img'] : ['txt2img']
  }

  private base(): string {
    const b = this.config.baseUrl.replace(/\/+$/, '')
    return b.endsWith('/v1') ? b : `${b}/v1`
  }

  private headers(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const started = Date.now()
    try {
      const res = await httpJson<{ data?: Array<{ id: string }> }>(
        joinUrl(this.base(), '/models'),
        { method: 'GET', headers: this.headers() },
        10_000
      )
      return {
        ok: true,
        message: `连接成功，可用模型 ${res.data?.length ?? 0} 个`,
        models: (res.data ?? []).map((m) => m.id),
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
    if (req.initImagePath && !this.capabilities.includes('img2img')) {
      throw new Error('当前服务不支持 img2img，动画帧生成请改用本地 Stable Diffusion')
    }

    const started = Date.now()
    const body = {
      model: this.config.model || 'dall-e-3',
      prompt: req.negativePrompt
        ? `${req.prompt}\n\nAvoid: ${req.negativePrompt}`
        : req.prompt,
      n: req.batchSize ?? 1,
      size: `${req.width}x${req.height}`,
      response_format: 'b64_json'
    }

    onProgress?.(0.15)
    let res: ImagesResponse
    try {
      res = await httpJson<ImagesResponse>(
        joinUrl(this.base(), '/images/generations'),
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal
        },
        ((this.config.options as OpenAiOptions)?.timeoutSec ?? 300) * 1000
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 部分服务不支持 response_format 参数，去掉后重试一次
      if (/response_format|unknown parameter|invalid/i.test(msg)) {
        const { response_format, ...fallback } = body
        void response_format
        res = await httpJson<ImagesResponse>(
          joinUrl(this.base(), '/images/generations'),
          { method: 'POST', headers: this.headers(), body: JSON.stringify(fallback), signal },
          300_000
        )
      } else {
        throw new Error(explainConnectionError(err, this.config.baseUrl))
      }
    }

    if (res.error?.message) throw new Error(`生图服务返回错误：${res.error.message}`)
    const items = res.data ?? []
    if (items.length === 0) throw new Error('生图服务未返回图片')

    onProgress?.(0.7)
    const dir = jobTempDir(this.jobId)
    const images: GenerateResult['images'] = []
    for (const item of items) {
      if (item.b64_json) {
        const path = await saveBase64Image(item.b64_json, dir, 'openai')
        images.push({ path, seed: typeof req.seed === 'number' ? req.seed : -1, width: req.width, height: req.height })
      } else if (item.url) {
        const buf = await fetchBinary(item.url)
        const path = await saveBufferImage(buf, dir, 'openai')
        images.push({ path, seed: typeof req.seed === 'number' ? req.seed : -1, width: req.width, height: req.height })
      }
    }
    await sleep(0)
    onProgress?.(1)

    return {
      images,
      meta: {
        providerId: this.config.id,
        providerType: 'openai-compat',
        model: body.model,
        durationMs: Date.now() - started
      }
    }
  }
}
