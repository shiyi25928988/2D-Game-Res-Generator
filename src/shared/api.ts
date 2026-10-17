import type {
  AppBootstrap,
  ConnectionTestResult,
  ExportGodotPayload,
  ExportResult,
  IconJobPayload,
  IconJobResult,
  JobProgressEvent,
  ProviderConfig,
  SpriteJobPayload,
  SpriteJobResult
} from './types'

export type JobFinishedPayload =
  | { jobId: string; kind: 'sprite'; result: SpriteJobResult }
  | { jobId: string; kind: 'icons'; result: IconJobResult }

export type JobFailedPayload = { jobId: string; kind: 'sprite' | 'icons'; error: string }

/** 预加载脚本暴露给渲染进程的完整 API 契约 */
export interface AppApi {
  bootstrap(): Promise<AppBootstrap>
  providers: {
    list(): Promise<ProviderConfig[]>
    upsert(config: ProviderConfig): Promise<ProviderConfig>
    remove(id: string): Promise<void>
    setDefault(id: string): Promise<void>
    test(config: ProviderConfig): Promise<ConnectionTestResult>
    onChanged(cb: (providers: ProviderConfig[]) => void): () => void
  }
  generate: {
    sprite(payload: SpriteJobPayload): Promise<{ jobId: string }>
    icons(payload: IconJobPayload): Promise<{ jobId: string }>
    cancel(jobId: string): Promise<void>
    onProgress(cb: (e: JobProgressEvent) => void): () => void
    onFinished(cb: (e: JobFinishedPayload) => void): () => void
    onFailed(cb: (e: JobFailedPayload) => void): () => void
  }
  exporter: {
    godot(payload: ExportGodotPayload): Promise<ExportResult>
    reveal(filePath: string): Promise<string>
    open(filePath: string): Promise<string>
  }
  dialog: {
    selectDirectory(title?: string): Promise<string | null>
    selectImage(): Promise<string | null>
  }
  system: {
    openPath(target: string): Promise<void>
    showInFolder(target: string): Promise<void>
  }
}
