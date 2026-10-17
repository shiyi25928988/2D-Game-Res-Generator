/**
 * 主进程 / 渲染进程共享的类型契约。
 * 不引入任何 Node 或 DOM 特有 API，保证两侧都能安全引用。
 */

export type ProviderType =
  | 'sd-webui'
  | 'comfyui'
  | 'openai-compat'
  | 'custom-http'

export type Capability = 'txt2img' | 'img2img' | 'controlnet' | 'upscale'

export interface ProviderConfig {
  id: string
  type: ProviderType
  name: string
  enabled: boolean
  /** 基础地址，本地 SD 形如 http://127.0.0.1:7860 */
  baseUrl: string
  /** 模型标识（WebUI 的 sd_model_checkpoint / ComfyUI 的 ckpt_name / OpenAI 的 model） */
  model?: string
  /**
   * 渲染进程永不收到明文密钥：
   * 主进程返回时始终为 undefined，仅用 hasApiKey 标记。
   * 新建/更新时由渲染进程传入明文，主进程加密后落盘。
   */
  apiKey?: string
  hasApiKey?: boolean
  /** 各类型专属参数（ComfyUI 工作流模板、自定义 HTTP 模板等） */
  options: Record<string, unknown>
  isDefault?: boolean
  createdAt?: number
  updatedAt?: number
}

export interface GenerateRequest {
  prompt: string
  negativePrompt?: string
  width: number
  height: number
  seed: number | 'random'
  steps?: number
  cfgScale?: number
  sampler?: string
  /** img2img 的初始图（本地文件绝对路径） */
  initImagePath?: string
  /** img2img 重绘强度 0~1 */
  denoise?: number
  /** 仅生成 N 张变体时使用 */
  batchSize?: number
  controlnet?: {
    module: 'openpose' | 'depth' | 'canny' | 'lineart'
    imagePath: string
    weight: number
  }
}

export interface GeneratedImage {
  /** 主进程落盘的临时文件绝对路径 */
  path: string
  seed: number
  width: number
  height: number
}

export interface GenerateResult {
  images: GeneratedImage[]
  meta: {
    providerId: string
    providerType: ProviderType
    model?: string
    sampler?: string
    durationMs: number
    /** 原始响应，排错用（可能很大，UI 按需展开） */
    raw?: unknown
  }
}

export interface ConnectionTestResult {
  ok: boolean
  message: string
  models?: string[]
  /** 探测到的能力，用于 UI 动态启用动画帧等功能 */
  capabilities?: Capability[]
  latencyMs?: number
}

/** ---------------- 生成任务 ---------------- */

export interface SpriteActionSpec {
  name: string
  frames: number
  fps: number
  loop: boolean
  /** 动作幅度，影响 denoise 与骨架策略 */
  intensity: 'low' | 'medium' | 'high'
}

export interface SpriteJobPayload {
  projectId: string
  providerId: string
  stylePrompt: string
  negativePrompt?: string
  /** 已保存的风格参考母版；为空则先由管线生成一张 */
  referenceImagePath?: string
  canvasWidth: number
  canvasHeight: number
  /** 是否执行去底 */
  removeBackground: boolean
  /** 是否执行脚底基线 / 中心轴对齐 */
  autoAlign: boolean
  action: SpriteActionSpec
  /** 固定种子，保证可复现；-1 表示随机 */
  seed: number
  steps?: number
  cfgScale?: number
  sampler?: string
  /** 输出根目录，通常为项目 assets/generated */
  outputDir: string
  characterName: string
}

export interface IconJobPayload {
  projectId: string
  providerId: string
  prompt: string
  negativePrompt?: string
  size: number
  count: number
  removeBackground: boolean
  outputDir: string
  prefix: string
  seed: number
  steps?: number
  cfgScale?: number
}

export type JobStage =
  | 'queued'
  | 'generating-reference'
  | 'generating-frames'
  | 'postprocessing'
  | 'aligning'
  | 'validating'
  | 'exporting'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface JobProgressEvent {
  jobId: string
  stage: JobStage
  /** 0~1 */
  progress: number
  message: string
  /** 当前帧序号（动画任务） */
  frameIndex?: number
  totalFrames?: number
}

export interface SpriteFrameResult {
  index: number
  path: string
  seed: number
  /** 校验结果 */
  status: 'ok' | 'needs-review'
  warnings: string[]
}

export interface SpriteJobResult {
  jobId: string
  characterName: string
  action: SpriteActionSpec
  frames: SpriteFrameResult[]
  atlasPath: string
  godotResourcePath?: string
  canvasWidth: number
  canvasHeight: number
  providerLevel: 'A' | 'B' | 'C'
  warnings: string[]
}

export interface IconJobResult {
  jobId: string
  files: string[]
}

/** ---------------- 项目 / 素材 ---------------- */

export interface Project {
  id: string
  name: string
  rootPath: string
  createdAt: number
  updatedAt: number
}

export interface AppBootstrap {
  appVersion: string
  defaultOutputDir: string
  providers: ProviderConfig[]
}

/** ---------------- 导出 ---------------- */

export interface ExportGodotPayload {
  /** 图集 png 绝对路径 */
  atlasPath: string
  actionName: string
  fps: number
  loop: boolean
  frameWidth: number
  frameHeight: number
  frameCount: number
  /** Godot 项目根目录；导出到 <root>/assets/generated/<character>/ */
  godotProjectRoot: string
  characterName: string
  /** 同时导出给其他引擎用的 JSON 图集 */
  exportJson?: boolean
}

export interface ExportResult {
  files: string[]
  warnings: string[]
}
