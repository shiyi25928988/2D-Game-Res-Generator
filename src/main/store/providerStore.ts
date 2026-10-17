import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProviderConfig } from '@shared/types'

/**
 * 轻量 JSON 存储。
 * 刻意不用 SQLite：MVP 阶段数据量小，避免原生模块在 Electron 下的重编译问题。
 * 后续需要时可按同一接口替换为 better-sqlite3。
 */

interface StoredProvider extends Omit<ProviderConfig, 'apiKey' | 'hasApiKey'> {
  /** safeStorage 加密后的 base64；safeStorage 不可用时为 undefined */
  apiKeyCipher?: string
  /** safeStorage 不可用时的降级存储（仅本机，会给出警告） */
  apiKeyPlain?: string
}

interface StoreShape {
  version: number
  providers: StoredProvider[]
}

const DATA_DIR = (): string => {
  const dir = join(app.getPath('userData'), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

const STORE_FILE = (): string => join(DATA_DIR(), 'store.json')

let cache: StoreShape | null = null

function load(): StoreShape {
  if (cache) return cache
  const file = STORE_FILE()
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as StoreShape
      cache = { version: parsed.version ?? 1, providers: parsed.providers ?? [] }
    } catch {
      cache = { version: 1, providers: [] }
    }
  } else {
    cache = { version: 1, providers: [] }
  }
  return cache
}

function persist(): void {
  const data = load()
  const file = STORE_FILE()
  const tmp = `${file}.tmp`
  // 先写临时文件再重命名，避免写入中断导致配置损坏
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmp, file)
}

function encryptKey(plain: string): Pick<StoredProvider, 'apiKeyCipher' | 'apiKeyPlain'> {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { apiKeyCipher: safeStorage.encryptString(plain).toString('base64') }
    }
  } catch {
    // 落到降级分支
  }
  return { apiKeyPlain: plain }
}

function decryptKey(p: StoredProvider): string | undefined {
  if (p.apiKeyCipher) {
    try {
      return safeStorage.decryptString(Buffer.from(p.apiKeyCipher, 'base64'))
    } catch {
      return undefined
    }
  }
  return p.apiKeyPlain
}

/** 对外暴露用：抹掉密钥，只保留是否存在 */
function toPublic(p: StoredProvider, defaultId?: string): ProviderConfig {
  const { apiKeyCipher, apiKeyPlain, ...rest } = p
  void apiKeyCipher
  void apiKeyPlain
  return { ...rest, hasApiKey: Boolean(p.apiKeyCipher || p.apiKeyPlain), isDefault: p.id === defaultId }
}

let defaultProviderId: string | undefined

export const providerStore = {
  list(): ProviderConfig[] {
    const data = load()
    if (!defaultProviderId && data.providers.length > 0) {
      defaultProviderId = data.providers.find((p) => p.enabled)?.id
    }
    return data.providers.map((p) => toPublic(p, defaultProviderId))
  },

  getRaw(id: string): { config: ProviderConfig; apiKey?: string } {
    const p = load().providers.find((x) => x.id === id)
    if (!p) throw new Error(`生图服务不存在：${id}`)
    return { config: { ...toPublic(p), apiKey: decryptKey(p) }, apiKey: decryptKey(p) }
  },

  upsert(input: ProviderConfig): ProviderConfig {
    const data = load()
    const now = Date.now()
    const existingIndex = data.providers.findIndex((p) => p.id === input.id)

    const base: StoredProvider = {
      id: input.id || randomUUID(),
      type: input.type,
      name: input.name,
      enabled: input.enabled ?? true,
      baseUrl: input.baseUrl,
      model: input.model,
      options: input.options ?? {},
      createdAt: existingIndex >= 0 ? data.providers[existingIndex].createdAt : now,
      updatedAt: now
    }

    // 只有显式传了非空 apiKey 才更新密钥；传空字符串表示清除
    if (typeof input.apiKey === 'string') {
      if (input.apiKey.length === 0) {
        base.apiKeyCipher = undefined
        base.apiKeyPlain = undefined
      } else {
        Object.assign(base, encryptKey(input.apiKey))
      }
    } else if (existingIndex >= 0) {
      base.apiKeyCipher = data.providers[existingIndex].apiKeyCipher
      base.apiKeyPlain = data.providers[existingIndex].apiKeyPlain
    }

    if (existingIndex >= 0) data.providers[existingIndex] = base
    else data.providers.push(base)
    persist()

    if (input.isDefault || !defaultProviderId) {
      defaultProviderId = base.id
    }
    return toPublic(base, defaultProviderId)
  },

  remove(id: string): void {
    const data = load()
    data.providers = data.providers.filter((p) => p.id !== id)
    if (defaultProviderId === id) defaultProviderId = data.providers[0]?.id
    persist()
  },

  setDefault(id: string): void {
    if (!load().providers.some((p) => p.id === id)) throw new Error('生图服务不存在')
    defaultProviderId = id
  },

  getDefaultId(): string | undefined {
    const data = load()
    if (!defaultProviderId) defaultProviderId = data.providers.find((p) => p.enabled)?.id
    return defaultProviderId
  }
}
