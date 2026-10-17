<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import type { ConnectionTestResult, ProviderConfig, ProviderType } from '@shared/types'
import { notify, store } from '../store/app'

const editing = ref(false)
const saving = ref(false)
const testing = ref(false)
const testResult = ref<ConnectionTestResult | null>(null)

const form = reactive({
  id: '',
  type: 'sd-webui' as ProviderType,
  name: '',
  baseUrl: 'http://127.0.0.1:7860',
  model: '',
  apiKey: '',
  clearKey: false,
  enabled: true,
  // sd-webui
  controlnetModel: '',
  sampler: '',
  // comfyui
  workflowTemplate: '',
  // openai
  enableImg2Img: false,
  // custom-http
  path: '/generate',
  testPath: '/',
  imagePath: 'data.0.b64_json',
  imageMode: 'base64' as 'base64' | 'url',
  bodyTemplate: '',
  headersJson: ''
})

const typeMeta: Record<ProviderType, { label: string; defaultUrl: string; hint: string }> = {
  'sd-webui': {
    label: '本地 SD · WebUI',
    defaultUrl: 'http://127.0.0.1:7860',
    hint: 'AUTOMATIC1111 / Forge。启动需加 --api --cors-allow-origins=*，并配置 ControlNet 模型以获得最佳动画效果。'
  },
  comfyui: {
    label: '本地 SD · ComfyUI',
    defaultUrl: 'http://127.0.0.1:8188',
    hint: '通过工作流驱动。不填模板时使用内置 txt2img / img2img 工作流，模型名需与 ComfyUI 中的 ckpt 名称一致。'
  },
  'openai-compat': {
    label: 'OpenAI 兼容接口',
    defaultUrl: 'https://api.openai.com',
    hint: '支持官方与各类中转服务。多数接口不支持 img2img，动画帧建议使用本地 SD。'
  },
  'custom-http': {
    label: '自定义 HTTP',
    defaultUrl: 'http://127.0.0.1:8000',
    hint: '用于自建服务。填写请求路径、请求体模板与响应中图片的提取路径即可接入。'
  }
}

const currentMeta = computed(() => typeMeta[form.type])

function resetForm(): void {
  form.id = ''
  form.type = 'sd-webui'
  form.name = ''
  form.baseUrl = 'http://127.0.0.1:7860'
  form.model = ''
  form.apiKey = ''
  form.clearKey = false
  form.enabled = true
  form.controlnetModel = ''
  form.sampler = ''
  form.workflowTemplate = ''
  form.enableImg2Img = false
  form.path = '/generate'
  form.testPath = '/'
  form.imagePath = 'data.0.b64_json'
  form.imageMode = 'base64'
  form.bodyTemplate = ''
  form.headersJson = ''
  testResult.value = null
}

function startCreate(): void {
  resetForm()
  editing.value = true
}

function startEdit(p: ProviderConfig): void {
  resetForm()
  form.id = p.id
  form.type = p.type
  form.name = p.name
  form.baseUrl = p.baseUrl
  form.model = p.model ?? ''
  form.enabled = p.enabled

  const o = (p.options ?? {}) as Record<string, unknown>
  form.controlnetModel = (o.controlnetModel as string) ?? ''
  form.sampler = (o.sampler as string) ?? ''
  form.workflowTemplate = (o.workflowTemplate as string) ?? ''
  form.enableImg2Img = Boolean(o.enableImg2Img)
  form.path = (o.path as string) ?? '/generate'
  form.testPath = (o.testPath as string) ?? '/'
  form.imagePath = (o.imagePath as string) ?? 'data.0.b64_json'
  form.imageMode = (o.imageMode as 'base64' | 'url') ?? 'base64'
  form.bodyTemplate = (o.bodyTemplate as string) ?? ''
  form.headersJson = (o.headersJson as string) ?? ''
  editing.value = true
}

function onTypeChange(): void {
  form.baseUrl = typeMeta[form.type].defaultUrl
  if (!form.name) form.name = typeMeta[form.type].label
}

function buildOptions(): Record<string, unknown> {
  switch (form.type) {
    case 'sd-webui':
      return {
        controlnetModel: form.controlnetModel.trim() || undefined,
        sampler: form.sampler.trim() || undefined
      }
    case 'comfyui':
      return {
        workflowTemplate: form.workflowTemplate.trim() || undefined,
        sampler: form.sampler.trim() || undefined
      }
    case 'openai-compat':
      return { enableImg2Img: form.enableImg2Img }
    case 'custom-http':
      return {
        path: form.path,
        testPath: form.testPath,
        imagePath: form.imagePath,
        imageMode: form.imageMode,
        bodyTemplate: form.bodyTemplate || undefined,
        headersJson: form.headersJson || undefined
      }
    default:
      return {}
  }
}

function buildConfig(): ProviderConfig {
  return {
    id: form.id,
    type: form.type,
    name: form.name.trim() || typeMeta[form.type].label,
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim() || undefined,
    enabled: form.enabled,
    options: buildOptions(),
    apiKey: form.clearKey ? '' : form.apiKey.trim() ? form.apiKey.trim() : undefined
  }
}

async function save(): Promise<void> {
  if (!form.baseUrl.trim()) {
    notify('请填写服务地址', 'error')
    return
  }
  saving.value = true
  try {
    await window.api.providers.upsert(buildConfig())
    store.providers = await window.api.providers.list()
    editing.value = false
    notify('生图服务已保存', 'ok')
  } catch (err) {
    notify((err as Error).message, 'error')
  } finally {
    saving.value = false
  }
}

async function test(): Promise<void> {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await window.api.providers.test(buildConfig())
    if (testResult.value.ok) notify('连接成功', 'ok')
    else notify('连接失败，请查看提示', 'error')
  } catch (err) {
    testResult.value = { ok: false, message: (err as Error).message }
  } finally {
    testing.value = false
  }
}

async function testSaved(p: ProviderConfig): Promise<void> {
  notify(`正在测试「${p.name}」…`)
  const res = await window.api.providers.test(p)
  notify(res.ok ? `${p.name}：${res.message}` : `${p.name}：${res.message}`, res.ok ? 'ok' : 'error')
}

async function setDefault(id: string): Promise<void> {
  await window.api.providers.setDefault(id)
  store.providers = await window.api.providers.list()
  notify('已设为默认服务', 'ok')
}

async function remove(p: ProviderConfig): Promise<void> {
  if (!window.confirm(`确定删除生图服务「${p.name}」？`)) return
  await window.api.providers.remove(p.id)
  store.providers = await window.api.providers.list()
  notify('已删除', 'ok')
}

const typeBadge = (t: ProviderType): string => typeMeta[t].label
</script>

<template>
  <div class="page-head">
    <div>
      <h1 class="page-title">生图服务</h1>
      <p class="page-desc">
        配置可用的生图后端。支持本地 Stable Diffusion（WebUI / ComfyUI）与云端 API，可随时切换默认服务。
        动画帧生成依赖 img2img 与 ControlNet，建议使用本地 SD。
      </p>
    </div>
    <button class="btn btn-primary" @click="startCreate">+ 添加服务</button>
  </div>

  <div v-if="store.providers.length === 0" class="card">
    <div class="empty">
      <div style="font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 6px">
        还没有配置任何生图服务
      </div>
      <div>添加一个本地 Stable Diffusion 服务即可开始生成。</div>
      <button class="btn btn-primary" style="margin-top: 14px" @click="startCreate">
        添加第一个服务
      </button>
    </div>
  </div>

  <div v-else class="provider-list">
    <div
      v-for="p in store.providers"
      :key="p.id"
      class="provider-row"
      :class="{ 'is-default': p.isDefault }"
    >
      <span class="status-dot" :class="p.enabled ? 'dot-ok' : 'dot-off'" />
      <div class="provider-main">
        <div class="provider-name">
          {{ p.name }}
          <span class="badge badge-muted">{{ typeBadge(p.type) }}</span>
          <span v-if="p.isDefault" class="badge badge-accent">默认</span>
          <span v-if="p.hasApiKey" class="badge badge-ok">已配置密钥</span>
        </div>
        <div class="provider-url">
          {{ p.baseUrl }}<span v-if="p.model"> · {{ p.model }}</span>
        </div>
      </div>
      <div class="provider-actions">
        <button class="btn btn-sm" @click="testSaved(p)">测试</button>
        <button v-if="!p.isDefault" class="btn btn-sm" @click="setDefault(p.id)">设为默认</button>
        <button class="btn btn-sm" @click="startEdit(p)">编辑</button>
        <button class="btn btn-sm btn-danger" @click="remove(p)">删除</button>
      </div>
    </div>
  </div>

  <!-- 编辑面板 -->
  <div v-if="editing" class="modal-mask" @click.self="editing = false">
    <div class="modal">
      <div class="modal-head">
        <div class="card-title">{{ form.id ? '编辑生图服务' : '添加生图服务' }}</div>
        <button class="btn btn-sm btn-ghost" @click="editing = false">关闭</button>
      </div>

      <div class="modal-body">
        <div class="grid-cols-2">
          <div class="field">
            <label class="label">服务类型</label>
            <select v-model="form.type" class="select" @change="onTypeChange">
              <option v-for="(meta, key) in typeMeta" :key="key" :value="key">{{ meta.label }}</option>
            </select>
          </div>
          <div class="field">
            <label class="label">显示名称</label>
            <input v-model="form.name" class="input" placeholder="例如：本地 SD 1.5" />
          </div>
        </div>

        <div class="alert alert-info" style="margin-bottom: 14px">
          {{ currentMeta.hint }}
        </div>

        <div class="field">
          <label class="label">服务地址</label>
          <input v-model="form.baseUrl" class="input" :placeholder="currentMeta.defaultUrl" />
        </div>

        <div class="grid-cols-2">
          <div class="field">
            <label class="label">
              模型
              <span class="hint">WebUI 填 checkpoint 名称</span>
            </label>
            <input v-model="form.model" class="input" placeholder="v1-5-pruned-emaonly.safetensors" />
          </div>
          <div class="field">
            <label class="label">
              API Key
              <span class="hint">本地服务可留空</span>
            </label>
            <input
              v-model="form.apiKey"
              class="input"
              type="password"
              :placeholder="form.id ? '留空则不修改' : 'sk-...'"
            />
          </div>
        </div>

        <label v-if="form.id && !form.apiKey" class="checkbox" style="margin-bottom: 12px">
          <input v-model="form.clearKey" type="checkbox" />
          清除已保存的密钥
        </label>

        <!-- 类型专属 -->
        <template v-if="form.type === 'sd-webui'">
          <div class="grid-cols-2">
            <div class="field">
              <label class="label">
                ControlNet 模型
                <span class="hint">留空则禁用姿态约束</span>
              </label>
              <input
                v-model="form.controlnetModel"
                class="input"
                placeholder="control_v11p_sd15_openpose [cab727d4]"
              />
            </div>
            <div class="field">
              <label class="label">采样器</label>
              <input v-model="form.sampler" class="input" placeholder="DPM++ 2M Karras" />
            </div>
          </div>
          <div class="hint" style="margin-top: -4px">
            填写 ControlNet 模型名后，动画帧会启用 OpenPose 骨架约束（一致性等级 A）。
          </div>
        </template>

        <template v-else-if="form.type === 'comfyui'">
          <div class="field">
            <label class="label">
              工作流模板（JSON）
              <span class="hint">留空使用内置工作流</span>
            </label>
            <textarea
              v-model="form.workflowTemplate"
              class="textarea"
              rows="6"
              placeholder='可使用占位符：{{prompt}} {{negative}} {{width}} {{height}} {{seed}} {{steps}} {{cfg}} {{denoise}} {{ckpt}} {{sampler}} {{initImage}}'
            />
          </div>
          <div class="field">
            <label class="label">采样器</label>
            <input v-model="form.sampler" class="input" placeholder="euler" />
          </div>
        </template>

        <template v-else-if="form.type === 'openai-compat'">
          <label class="checkbox">
            <input v-model="form.enableImg2Img" type="checkbox" />
            该服务支持 img2img（/images/edits）
          </label>
        </template>

        <template v-else>
          <div class="grid-cols-2">
            <div class="field">
              <label class="label">生成接口路径</label>
              <input v-model="form.path" class="input" placeholder="/generate" />
            </div>
            <div class="field">
              <label class="label">连通性测试路径</label>
              <input v-model="form.testPath" class="input" placeholder="/" />
            </div>
          </div>
          <div class="grid-cols-2">
            <div class="field">
              <label class="label">图片提取路径</label>
              <input v-model="form.imagePath" class="input" placeholder="data.0.b64_json" />
            </div>
            <div class="field">
              <label class="label">图片返回形式</label>
              <select v-model="form.imageMode" class="select">
                <option value="base64">base64</option>
                <option value="url">图片 URL</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label class="label">请求体模板</label>
            <textarea
              v-model="form.bodyTemplate"
              class="textarea"
              rows="4"
              placeholder='{"prompt":"{{prompt}}","width":{{width}},"height":{{height}},"seed":{{seed}}}'
            />
          </div>
          <div class="field">
            <label class="label">附加请求头（JSON）</label>
            <input v-model="form.headersJson" class="input" placeholder='{"X-Token":"xxx"}' />
          </div>
        </template>

        <div v-if="testResult" class="section-gap">
          <div class="alert" :class="testResult.ok ? 'alert-ok' : 'alert-danger'">
            <div>
              <strong>{{ testResult.ok ? '连接成功' : '连接失败' }}</strong>
              <div>{{ testResult.message }}</div>
              <div v-if="testResult.latencyMs" class="hint">耗时 {{ testResult.latencyMs }} ms</div>
              <div v-if="testResult.capabilities?.length" class="tag-list" style="margin-top: 6px">
                <span v-for="c in testResult.capabilities" :key="c" class="badge badge-muted">{{ c }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-foot">
        <button class="btn" :disabled="testing" @click="test">
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <div class="spacer" />
        <button class="btn" @click="editing = false">取消</button>
        <button class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(22, 25, 38, 0.36);
  display: grid;
  place-items: center;
  z-index: 80;
  padding: 24px;
}

.modal {
  width: 640px;
  max-width: 100%;
  max-height: 88vh;
  background: var(--panel);
  border-radius: 12px;
  box-shadow: 0 18px 50px rgba(20, 22, 40, 0.22);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}

.modal-body {
  padding: 16px 18px;
  overflow-y: auto;
}

.modal-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
  background: var(--panel-soft);
}
</style>
