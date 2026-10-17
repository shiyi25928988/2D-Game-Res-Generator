import type {
  Capability,
  ConnectionTestResult,
  GenerateRequest,
  GenerateResult,
  ProviderConfig
} from '@shared/types'

export interface ImageProvider {
  readonly config: ProviderConfig
  /** 动态能力：部分能力取决于用户配置（如是否装了 ControlNet 模型） */
  readonly capabilities: Capability[]
  testConnection(): Promise<ConnectionTestResult>
  generate(
    req: GenerateRequest,
    onProgress?: (progress: number) => void,
    signal?: AbortSignal
  ): Promise<GenerateResult>
}

export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return `${b}${p}`
}

export async function httpJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 30_000
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      ...init,
      signal: init.signal ?? controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined)
      }
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 300)}` : ''}`)
    }
    return text ? (JSON.parse(text) as T) : ({} as T)
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchBinary(url: string, init: RequestInit = {}): Promise<Buffer> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`下载图片失败：HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

export async function fetchBinaryWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 30_000
): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchBinary(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 根据错误对象生成用户能看懂的自查建议 */
export function explainConnectionError(err: unknown, baseUrl: string): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/abort|timeout/i.test(raw)) {
    return `连接超时。请确认服务已启动并监听 ${baseUrl}（本地 SD 需带 --api 参数启动，ComfyUI 默认端口 8188）。`
  }
  if (/ECONNREFUSED|fetch failed/i.test(raw)) {
    return `无法连接 ${baseUrl}。请检查地址与端口，以及服务是否已启动。`
  }
  if (/HTTP 401|HTTP 403/i.test(raw)) {
    return '鉴权失败，请检查 API Key 是否正确、是否已过期。'
  }
  if (/HTTP 404/i.test(raw)) {
    return '接口路径不存在，请确认服务类型选择是否正确（WebUI / ComfyUI 的接口不同）。'
  }
  return raw
}
