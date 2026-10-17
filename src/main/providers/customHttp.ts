import type {
  Capability,
  ConnectionTestResult,
  GenerateRequest,
  GenerateResult,
  ProviderConfig
} from '@shared/types'
import { fileToBase64, jobTempDir, saveBase64Image, saveBufferImage } from '../util/files'
import {
  explainConnectionError,
  fetchBinary,
  httpJson,
  joinUrl,
  type ImageProvider
} from './types'

interface CustomHttpOptions {
  path?: string
  method?: 'POST' | 'PUT'
  headersJson?: string
  /** 请求体模板，支持 {{prompt}} {{negative}} {{width}} {{height}} {{seed}} {{steps}} {{cfg}} {{denoise}} {{image}} */
  bodyTemplate?: string
  /** 响应中图片的路径，如 data.0.b64_json */
  imagePath?: string
  imageMode?: 'base64' | 'url'
  testPath?: string
  timeoutSec?: number
}

/**
 * 自定义 HTTP：给自建服务或未适配的平台兜底。
 * 用户配置请求模板与响应提取路径，管线侧不感知差异。
 */
export class CustomHttpProvider implements ImageProvider {
  readonly capabilities: Capability[] = ['txt2img']

  constructor(
    readonly config: ProviderConfig,
    private readonly apiKey?: string,
    private readonly jobId = 'adhoc'
  ) {}

  private get opts(): CustomHttpOptions {
    return (this.config.options ?? {}) as CustomHttpOptions
  }

  private headers(): Record<string, string> {
    const base: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) base.Authorization = `Bearer ${this.apiKey}`
    const raw = this.opts.headersJson?.trim()
    if (raw) {
      try {
        Object.assign(base, JSON.parse(raw) as Record<string, string>)
      } catch {
        throw new Error('自定义请求头不是合法 JSON')
      }
    }
    return base
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const started = Date.now()
    const url = joinUrl(this.config.baseUrl, this.opts.testPath ?? '/')
    try {
      const res = await fetch(url, { method: 'GET', headers: this.headers() })
      return {
        ok: res.status < 500,
        message: res.status < 500 ? `服务可达（HTTP ${res.status}）` : `服务异常：HTTP ${res.status}`,
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
    const imageBase64 = req.initImagePath ? await fileToBase64(req.initImagePath) : ''
    const tpl = this.opts.bodyTemplate?.trim()

    const body = tpl
      ? tpl
          .replace(/\{\{prompt\}\}/g, escapeJson(req.prompt))
          .replace(/\{\{negative\}\}/g, escapeJson(req.negativePrompt ?? ''))
          .replace(/\{\{width\}\}/g, String(req.width))
          .replace(/\{\{height\}\}/g, String(req.height))
          .replace(/\{\{seed\}\}/g, String(req.seed === 'random' ? -1 : req.seed))
          .replace(/\{\{steps\}\}/g, String(req.steps ?? 24))
          .replace(/\{\{cfg\}\}/g, String(req.cfgScale ?? 7))
          .replace(/\{\{denoise\}\}/g, String(req.denoise ?? 0.55))
          .replace(/\{\{image\}\}/g, imageBase64)
      : JSON.stringify({
          prompt: req.prompt,
          negative_prompt: req.negativePrompt ?? '',
          width: req.width,
          height: req.height,
          seed: req.seed,
          steps: req.steps ?? 24,
          cfg_scale: req.cfgScale ?? 7
        })

    onProgress?.(0.2)
    const res = await httpJson<unknown>(
      joinUrl(this.config.baseUrl, this.opts.path ?? '/generate'),
      {
        method: this.opts.method ?? 'POST',
        headers: this.headers(),
        body,
        signal
      },
      (this.opts.timeoutSec ?? 300) * 1000
    )

    const imagePath = this.opts.imagePath ?? 'data.0.b64_json'
    const extracted = getByPath(res, imagePath)
    if (typeof extracted !== 'string' || !extracted) {
      throw new Error(`未能从响应中提取图片，请检查提取路径「${imagePath}」是否正确`)
    }

    onProgress?.(0.8)
    const dir = jobTempDir(this.jobId)
    const mode = this.opts.imageMode ?? 'base64'
    const path =
      mode === 'url'
        ? await saveBufferImage(await fetchBinary(extracted), dir, 'custom')
        : await saveBase64Image(extracted, dir, 'custom')

    onProgress?.(1)
    return {
      images: [{ path, seed: typeof req.seed === 'number' ? req.seed : -1, width: req.width, height: req.height }],
      meta: {
        providerId: this.config.id,
        providerType: 'custom-http',
        durationMs: Date.now() - started,
        raw: res
      }
    }
  }
}

function escapeJson(s: string): string {
  return JSON.stringify(s).slice(1, -1)
}

/** 支持 "data.0.b64_json" 这类路径取值 */
export function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined
    if (Array.isArray(acc)) {
      const idx = Number(key)
      return Number.isInteger(idx) ? acc[idx] : undefined
    }
    if (typeof acc === 'object') return (acc as Record<string, unknown>)[key]
    return undefined
  }, obj)
}
