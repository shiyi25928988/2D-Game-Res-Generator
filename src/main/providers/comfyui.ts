import type {
  Capability,
  ConnectionTestResult,
  GenerateRequest,
  GenerateResult,
  ProviderConfig
} from '@shared/types'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { jobTempDir, saveBufferImage } from '../util/files'
import {
  explainConnectionError,
  fetchBinary,
  httpJson,
  joinUrl,
  sleep,
  type ImageProvider
} from './types'

interface ComfyOptions {
  /** 自定义工作流 JSON 模板（字符串），支持 {{prompt}} 等占位符 */
  workflowTemplate?: string
  sampler?: string
  timeoutSec?: number
}

interface ComfyPromptResponse {
  prompt_id: string
  number?: number
  node_errors?: Record<string, unknown>
}

interface ComfyHistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: unknown }
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>
}

type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>

/**
 * ComfyUI：/prompt 提交工作流，/history 轮询，/view 取图。
 * 未提供自定义模板时使用内置 txt2img / img2img 工作流。
 */
export class ComfyuiProvider implements ImageProvider {
  readonly capabilities: Capability[] = ['txt2img', 'img2img']

  constructor(
    readonly config: ProviderConfig,
    private readonly apiKey?: string,
    private readonly jobId = 'adhoc'
  ) {}

  private get opts(): ComfyOptions {
    return (this.config.options ?? {}) as ComfyOptions
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {}
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`
    return h
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const started = Date.now()
    try {
      const stats = await httpJson<Record<string, unknown>>(
        joinUrl(this.config.baseUrl, '/system_stats'),
        { method: 'GET', headers: this.headers() },
        8000
      )
      void stats
      return {
        ok: true,
        message: '连接成功（ComfyUI）',
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
    const timeoutMs = (this.opts.timeoutSec ?? 600) * 1000

    let initImageName: string | undefined
    if (req.initImagePath) {
      initImageName = await this.uploadImage(req.initImagePath)
    }

    const workflow = this.buildWorkflow(req, initImageName)
    const clientId = `resgen-${this.jobId}-${Date.now()}`

    const queued = await httpJson<ComfyPromptResponse>(
      joinUrl(this.config.baseUrl, '/prompt'),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ prompt: workflow, client_id: clientId })
      },
      30_000
    )

    if (queued.node_errors && Object.keys(queued.node_errors).length > 0) {
      throw new Error(
        `工作流节点校验失败：${JSON.stringify(queued.node_errors).slice(0, 400)}（请检查模型名与节点配置）`
      )
    }
    if (!queued.prompt_id) throw new Error('ComfyUI 未返回 prompt_id，工作流可能不合法')

    const history = await this.waitForResult(queued.prompt_id, timeoutMs, onProgress, signal)
    const images: GenerateResult['images'] = []

    for (const node of Object.values(history.outputs ?? {})) {
      for (const img of node.images ?? []) {
        const buf = await fetchBinary(
          joinUrl(
            this.config.baseUrl,
            `/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder)}&type=${img.type}`
          ),
          { headers: this.headers() }
        )
        const path = await saveBufferImage(buf, jobTempDir(this.jobId), 'comfy')
        images.push({
          path,
          seed: typeof req.seed === 'number' ? req.seed : -1,
          width: req.width,
          height: req.height
        })
      }
    }

    if (images.length === 0) {
      throw new Error('ComfyUI 执行完成但未产出图片，请确认工作流中包含 SaveImage 节点')
    }
    onProgress?.(1)

    return {
      images,
      meta: {
        providerId: this.config.id,
        providerType: 'comfyui',
        model: this.config.model,
        sampler: this.opts.sampler,
        durationMs: Date.now() - started
      }
    }
  }

  private async uploadImage(filePath: string): Promise<string> {
    const buf = await readFile(filePath)
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array(buf)], { type: 'image/png' }), basename(filePath))
    form.append('overwrite', 'true')

    const res = await fetch(joinUrl(this.config.baseUrl, '/upload/image'), {
      method: 'POST',
      body: form,
      headers: this.headers()
    })
    if (!res.ok) throw new Error(`上传参考图失败：HTTP ${res.status}`)
    const data = (await res.json()) as { name: string; subfolder?: string }
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name
  }

  private async waitForResult(
    promptId: string,
    timeoutMs: number,
    onProgress?: (p: number) => void,
    signal?: AbortSignal
  ): Promise<ComfyHistoryEntry> {
    const start = Date.now()
    let tick = 0
    for (;;) {
      if (signal?.aborted) throw new Error('已取消')
      if (Date.now() - start > timeoutMs) throw new Error('ComfyUI 生成超时，请检查队列与显存占用')

      const hist = await httpJson<Record<string, ComfyHistoryEntry>>(
        joinUrl(this.config.baseUrl, `/history/${promptId}`),
        { method: 'GET', headers: this.headers() },
        10_000
      )
      const entry = hist[promptId]
      if (entry) {
        if (entry.status?.status_str === 'error') {
          throw new Error(`ComfyUI 执行出错：${JSON.stringify(entry.status.messages ?? {}).slice(0, 400)}`)
        }
        if (entry.outputs && Object.keys(entry.outputs).length > 0) return entry
      }
      tick += 1
      // 无 WebSocket 进度时用渐进值提示，避免进度条长时间停在 0
      onProgress?.(Math.min(0.9, 0.1 + tick * 0.03))
      await sleep(1000)
    }
  }

  private buildWorkflow(req: GenerateRequest, initImageName?: string): Workflow {
    const negative = req.negativePrompt ?? ''
    const seed = req.seed === 'random' ? Math.floor(Math.random() * 1_000_000_000) : req.seed
    const steps = req.steps ?? 24
    const cfg = req.cfgScale ?? 7
    const sampler = req.sampler ?? this.opts.sampler ?? 'euler'
    const ckpt = this.config.model ?? 'v1-5-pruned-emaonly.safetensors'
    const denoise = initImageName ? (req.denoise ?? 0.55) : 1

    const template = this.opts.workflowTemplate?.trim()
    if (template) {
      const replaced = template
        .replace(/\{\{prompt\}\}/g, escapeJson(req.prompt))
        .replace(/\{\{negative\}\}/g, escapeJson(negative))
        .replace(/\{\{width\}\}/g, String(req.width))
        .replace(/\{\{height\}\}/g, String(req.height))
        .replace(/\{\{seed\}\}/g, String(seed))
        .replace(/\{\{steps\}\}/g, String(steps))
        .replace(/\{\{cfg\}\}/g, String(cfg))
        .replace(/\{\{denoise\}\}/g, String(denoise))
        .replace(/\{\{ckpt\}\}/g, escapeJson(ckpt))
        .replace(/\{\{sampler\}\}/g, escapeJson(sampler))
        .replace(/\{\{initImage\}\}/g, escapeJson(initImageName ?? ''))
      try {
        return JSON.parse(replaced) as Workflow
      } catch (err) {
        throw new Error(`自定义工作流模板 JSON 解析失败：${(err as Error).message}`)
      }
    }

    const wf: Workflow = {
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: req.prompt, clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } },
      '3': {
        class_type: 'KSampler',
        inputs: {
          seed,
          steps,
          cfg,
          sampler_name: sampler,
          scheduler: 'normal',
          denoise,
          model: ['4', 0],
          positive: ['6', 0],
          negative: ['7', 0],
          latent_image: initImageName ? ['11', 0] : ['5', 0]
        }
      },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      '9': {
        class_type: 'SaveImage',
        inputs: { filename_prefix: 'resgen', images: ['8', 0] }
      }
    }

    if (initImageName) {
      wf['10'] = { class_type: 'LoadImage', inputs: { image: initImageName } }
      wf['11'] = { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['4', 2] } }
    } else {
      wf['5'] = {
        class_type: 'EmptyLatentImage',
        inputs: { width: req.width, height: req.height, batch_size: req.batchSize ?? 1 }
      }
    }

    return wf
  }
}

/** 把字符串转义为可安全嵌入 JSON 的片段（用于字符串模板替换） */
function escapeJson(s: string): string {
  return JSON.stringify(s).slice(1, -1)
}
