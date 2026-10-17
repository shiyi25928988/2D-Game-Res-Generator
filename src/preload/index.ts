import { contextBridge, ipcRenderer } from 'electron'
import type { AppApi, JobFailedPayload, JobFinishedPayload } from '../shared/api'
import type {
  ConnectionTestResult,
  ExportResult,
  JobProgressEvent,
  ProviderConfig
} from '../shared/types'

const api: AppApi = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),

  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
    upsert: (config: ProviderConfig) => ipcRenderer.invoke('providers:upsert', config),
    remove: (id: string) => ipcRenderer.invoke('providers:remove', id),
    setDefault: (id: string) => ipcRenderer.invoke('providers:setDefault', id),
    test: (config: ProviderConfig): Promise<ConnectionTestResult> =>
      ipcRenderer.invoke('providers:test', config),
    onChanged: (cb: (providers: ProviderConfig[]) => void) => {
      const handler = (_e: unknown, providers: ProviderConfig[]): void => cb(providers)
      ipcRenderer.on('providers:changed', handler)
      return () => ipcRenderer.off('providers:changed', handler)
    }
  },

  generate: {
    sprite: (payload) => ipcRenderer.invoke('generate:sprite', payload),
    icons: (payload) => ipcRenderer.invoke('generate:icons', payload),
    cancel: (jobId: string) => ipcRenderer.invoke('job:cancel', jobId),
    onProgress: (cb: (e: JobProgressEvent) => void) => {
      const handler = (_e: unknown, payload: JobProgressEvent): void => cb(payload)
      ipcRenderer.on('job:progress', handler)
      return () => ipcRenderer.off('job:progress', handler)
    },
    onFinished: (cb: (e: JobFinishedPayload) => void) => {
      const handler = (_e: unknown, payload: JobFinishedPayload): void => cb(payload)
      ipcRenderer.on('job:finished', handler)
      return () => ipcRenderer.off('job:finished', handler)
    },
    onFailed: (cb: (e: JobFailedPayload) => void) => {
      const handler = (_e: unknown, payload: JobFailedPayload): void => cb(payload)
      ipcRenderer.on('job:failed', handler)
      return () => ipcRenderer.off('job:failed', handler)
    }
  },

  exporter: {
    godot: (payload): Promise<ExportResult> => ipcRenderer.invoke('export:godot', payload),
    reveal: (filePath: string) => ipcRenderer.invoke('export:reveal', filePath),
    open: (filePath: string) => ipcRenderer.invoke('export:open', filePath)
  },

  dialog: {
    selectDirectory: (title?: string) => ipcRenderer.invoke('dialog:selectDirectory', title),
    selectImage: () => ipcRenderer.invoke('dialog:selectImage')
  },

  system: {
    openPath: (target: string) => ipcRenderer.invoke('system:openPath', target),
    showInFolder: (target: string) => ipcRenderer.invoke('system:showInFolder', target)
  }
}

contextBridge.exposeInMainWorld('api', api)
