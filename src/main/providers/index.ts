import type { ProviderConfig } from '@shared/types'
import type { ImageProvider } from './types'
import { SdWebuiProvider } from './sdWebui'
import { ComfyuiProvider } from './comfyui'
import { OpenAiCompatProvider } from './openaiCompat'
import { CustomHttpProvider } from './customHttp'
import { providerStore } from '../store/providerStore'

export function createProvider(config: ProviderConfig, apiKey?: string, jobId?: string): ImageProvider {
  switch (config.type) {
    case 'sd-webui':
      return new SdWebuiProvider(config, apiKey, jobId)
    case 'comfyui':
      return new ComfyuiProvider(config, apiKey, jobId)
    case 'openai-compat':
      return new OpenAiCompatProvider(config, apiKey, jobId)
    case 'custom-http':
      return new CustomHttpProvider(config, apiKey, jobId)
    default:
      throw new Error(`未知的生图服务类型：${(config as ProviderConfig).type}`)
  }
}

/** 按 id 取 Provider；id 为空时取默认服务 */
export function resolveProvider(providerId?: string, jobId?: string): ImageProvider {
  const id = providerId || providerStore.getDefaultId()
  if (!id) throw new Error('尚未配置生图服务，请先在「生图服务」页面添加一个')
  const { config, apiKey } = providerStore.getRaw(id)
  if (!config.enabled) throw new Error(`生图服务「${config.name}」已被禁用`)
  return createProvider(config, apiKey, jobId)
}

export function capabilitiesOf(type: ProviderConfig['type'], options: Record<string, unknown>): string[] {
  switch (type) {
    case 'sd-webui': {
      const cn = Boolean((options as { controlnetModel?: string }).controlnetModel)
      return ['txt2img', 'img2img', ...(cn ? ['controlnet'] : [])]
    }
    case 'comfyui':
      return ['txt2img', 'img2img']
    case 'openai-compat':
      return (options as { enableImg2Img?: boolean }).enableImg2Img
        ? ['txt2img', 'img2img']
        : ['txt2img']
    default:
      return ['txt2img']
  }
}
