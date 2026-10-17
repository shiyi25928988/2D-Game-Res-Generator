import { reactive } from 'vue'
import type { ProviderConfig } from '@shared/types'

export type ViewKey = 'sprite' | 'icons' | 'providers'

export const store = reactive({
  ready: false,
  appVersion: '',
  defaultOutputDir: '',
  providers: [] as ProviderConfig[],
  active: 'sprite' as ViewKey,
  toast: '' as string,
  toastKind: 'info' as 'info' | 'ok' | 'error'
})

let toastTimer: number | undefined

export function notify(message: string, kind: 'info' | 'ok' | 'error' = 'info'): void {
  store.toast = message
  store.toastKind = kind
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    store.toast = ''
  }, 4200)
}

export async function initStore(): Promise<void> {
  const boot = await window.api.bootstrap()
  store.appVersion = boot.appVersion
  store.defaultOutputDir = boot.defaultOutputDir
  store.providers = boot.providers
  store.ready = true

  window.api.providers.onChanged((list) => {
    store.providers = list
  })
}

export function providerById(id: string): ProviderConfig | undefined {
  return store.providers.find((p) => p.id === id)
}

export function defaultProvider(): ProviderConfig | undefined {
  return store.providers.find((p) => p.isDefault) ?? store.providers[0]
}

/** 把本地绝对路径转成可被 <img> 读取的协议地址 */
export function fileUrl(path: string): string {
  if (!path) return ''
  const normalized = path.replace(/\\/g, '/')
  return `resgen:///${encodeURI(normalized)}`
}
