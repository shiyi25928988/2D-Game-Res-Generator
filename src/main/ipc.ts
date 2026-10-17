import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { app } from 'electron'
import type {
  ExportGodotPayload,
  IconJobPayload,
  JobProgressEvent,
  ProviderConfig,
  SpriteJobPayload
} from '@shared/types'
import { providerStore } from './store/providerStore'
import { createProvider, resolveProvider } from './providers'
import { runSpriteJob } from './pipeline/sprite'
import { runIconJob } from './pipeline/icons'
import { exportGodot } from './exporter/godot'

const jobs = new Map<string, AbortController>()

function send(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

export function registerIpc(): void {
  // ---------- 基础信息 ----------
  ipcMain.handle('app:bootstrap', () => {
    return {
      appVersion: app.getVersion(),
      defaultOutputDir: join(app.getPath('documents'), 'ResGen'),
      providers: providerStore.list()
    }
  })

  ipcMain.handle('system:openPath', async (_e, target: string) => {
    await shell.openPath(target)
  })

  ipcMain.handle('system:showInFolder', (_e, target: string) => {
    shell.showItemInFolder(target)
  })

  // ---------- 目录/文件选择 ----------
  ipcMain.handle('dialog:selectDirectory', async (_e, title?: string) => {
    const res = await dialog.showOpenDialog({
      title: title ?? '选择目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('dialog:selectImage', async () => {
    const res = await dialog.showOpenDialog({
      title: '选择参考图',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    return res.canceled ? null : res.filePaths[0]
  })

  // ---------- 生图服务配置 ----------
  ipcMain.handle('providers:list', () => providerStore.list())

  ipcMain.handle('providers:upsert', (_e, config: ProviderConfig) => {
    const saved = providerStore.upsert(config)
    send('providers:changed', providerStore.list())
    return saved
  })

  ipcMain.handle('providers:remove', (_e, id: string) => {
    providerStore.remove(id)
    send('providers:changed', providerStore.list())
  })

  ipcMain.handle('providers:setDefault', (_e, id: string) => {
    providerStore.setDefault(id)
    send('providers:changed', providerStore.list())
  })

  ipcMain.handle('providers:test', async (_e, config: ProviderConfig) => {
    // 编辑中的配置也能测试：优先用传入的 apiKey，否则回落到已保存的密钥
    let apiKey = config.apiKey
    if (!apiKey && config.id) {
      try {
        apiKey = providerStore.getRaw(config.id).apiKey
      } catch {
        apiKey = undefined
      }
    }
    const provider = createProvider(config, apiKey, 'test')
    return provider.testConnection()
  })

  // ---------- 生成任务 ----------
  ipcMain.handle('generate:sprite', async (_e, payload: SpriteJobPayload) => {
    const jobId = randomUUID()
    const controller = new AbortController()
    jobs.set(jobId, controller)

    void (async () => {
      try {
        const provider = resolveProvider(payload.providerId, jobId)
        const result = await runSpriteJob(
          jobId,
          payload,
          provider,
          (evt: JobProgressEvent) => send('job:progress', evt),
          controller.signal
        )
        send('job:finished', { jobId, kind: 'sprite', result })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        send('job:failed', { jobId, kind: 'sprite', error: message })
      } finally {
        jobs.delete(jobId)
      }
    })()

    return { jobId }
  })

  ipcMain.handle('generate:icons', async (_e, payload: IconJobPayload) => {
    const jobId = randomUUID()
    const controller = new AbortController()
    jobs.set(jobId, controller)

    void (async () => {
      try {
        const provider = resolveProvider(payload.providerId, jobId)
        const result = await runIconJob(
          jobId,
          payload,
          provider,
          (evt: JobProgressEvent) => send('job:progress', evt),
          controller.signal
        )
        send('job:finished', { jobId, kind: 'icons', result })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        send('job:failed', { jobId, kind: 'icons', error: message })
      } finally {
        jobs.delete(jobId)
      }
    })()

    return { jobId }
  })

  ipcMain.handle('job:cancel', (_e, jobId: string) => {
    jobs.get(jobId)?.abort()
  })

  // ---------- 导出 ----------
  ipcMain.handle('export:godot', async (_e, payload: ExportGodotPayload) => {
    const result = await exportGodot({
      atlasPath: payload.atlasPath,
      actionName: payload.actionName,
      characterName: payload.characterName,
      fps: payload.fps,
      loop: payload.loop,
      frameWidth: payload.frameWidth,
      frameHeight: payload.frameHeight,
      frameCount: payload.frameCount,
      godotProjectRoot: payload.godotProjectRoot,
      exportJson: payload.exportJson
    })
    return result
  })

  ipcMain.handle('export:reveal', (_e, filePath: string) => {
    shell.showItemInFolder(filePath)
    return dirname(filePath)
  })

  ipcMain.handle('export:open', async (_e, filePath: string) => {
    await shell.openPath(dirname(filePath))
    return basename(filePath)
  })
}
