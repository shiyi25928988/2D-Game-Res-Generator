<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type { IconJobResult, JobProgressEvent } from '@shared/types'
import { defaultProvider, fileUrl, notify, store } from '../store/app'

const form = reactive({
  providerId: '',
  prompt: 'pixel art, iron sword with blue gem, fantasy RPG item',
  size: 128,
  count: 4,
  prefix: 'sword',
  removeBackground: true,
  seed: -1,
  steps: 24,
  outputDir: ''
})

const jobId = ref('')
const running = ref(false)
const progress = ref<JobProgressEvent | null>(null)
const error = ref('')
const result = ref<IconJobResult | null>(null)
const offs: Array<() => void> = []

const ready = computed(() => store.providers.length > 0)

async function pickDir(): Promise<void> {
  const dir = await window.api.dialog.selectDirectory('选择图标输出目录')
  if (dir) form.outputDir = dir
}

async function start(): Promise<void> {
  error.value = ''
  result.value = null
  if (!form.providerId) return notify('请先选择生图服务', 'error')
  if (!form.outputDir) return notify('请选择输出目录', 'error')

  running.value = true
  try {
    const res = await window.api.generate.icons({
      projectId: 'local',
      providerId: form.providerId,
      prompt: form.prompt,
      negativePrompt: 'text, watermark, multiple objects, border',
      size: form.size,
      count: form.count,
      removeBackground: form.removeBackground,
      outputDir: form.outputDir,
      prefix: form.prefix,
      seed: form.seed,
      steps: form.steps
    })
    jobId.value = res.jobId
  } catch (err) {
    running.value = false
    error.value = (err as Error).message
  }
}

function reveal(): void {
  if (result.value?.files[0]) void window.api.exporter.reveal(result.value.files[0])
}

onMounted(() => {
  form.outputDir = store.defaultOutputDir
  const def = defaultProvider()
  if (def) form.providerId = def.id

  offs.push(
    window.api.generate.onProgress((e) => {
      if (e.jobId === jobId.value) progress.value = e
    }),
    window.api.generate.onFinished((e) => {
      if (e.jobId !== jobId.value || e.kind !== 'icons') return
      running.value = false
      result.value = e.result
      notify(`已生成 ${e.result.files.length} 个图标`, 'ok')
    }),
    window.api.generate.onFailed((e) => {
      if (e.jobId !== jobId.value || e.kind !== 'icons') return
      running.value = false
      error.value = e.error
    })
  )
})

onBeforeUnmount(() => offs.forEach((off) => off()))
</script>

<template>
  <div class="page-head">
    <div>
      <h1 class="page-title">图标生成</h1>
      <p class="page-desc">
        批量生成同风格的物品 / 技能图标，自动去底并居中，可直接用于背包、技能栏等 UI。
      </p>
    </div>
  </div>

  <div v-if="!ready" class="card">
    <div class="empty">
      还没有配置生图服务。
      <button class="btn btn-sm" style="margin-left: 8px" @click="store.active = 'providers'">去配置</button>
    </div>
  </div>

  <div v-else class="grid-2">
    <div class="card">
      <div class="card-head"><div class="card-title">生成配置</div></div>
      <div class="card-body">
        <div class="field">
          <label class="label">生图服务</label>
          <select v-model="form.providerId" class="select">
            <option v-for="p in store.providers" :key="p.id" :value="p.id">
              {{ p.name }}{{ p.isDefault ? '（默认）' : '' }}
            </option>
          </select>
        </div>

        <div class="field">
          <label class="label">描述</label>
          <textarea v-model="form.prompt" class="textarea" rows="3" style="font-family: var(--font); font-size: 12.5px" />
          <div class="hint">建议描述单一物体的材质与风格，不要包含背景描述。</div>
        </div>

        <div class="grid-cols-2">
          <div class="field">
            <label class="label">尺寸</label>
            <select v-model.number="form.size" class="select">
              <option :value="64">64 × 64</option>
              <option :value="128">128 × 128</option>
              <option :value="256">256 × 256</option>
              <option :value="512">512 × 512</option>
            </select>
          </div>
          <div class="field">
            <label class="label">数量</label>
            <input v-model.number="form.count" type="number" min="1" max="12" class="input" />
          </div>
        </div>

        <div class="grid-cols-2">
          <div class="field">
            <label class="label">文件前缀</label>
            <input v-model="form.prefix" class="input" placeholder="sword" />
          </div>
          <div class="field">
            <label class="label">随机种子</label>
            <input v-model.number="form.seed" type="number" class="input" />
          </div>
        </div>

        <div class="field">
          <label class="checkbox">
            <input v-model="form.removeBackground" type="checkbox" />
            自动去底
          </label>
        </div>

        <div class="field">
          <label class="label">输出目录</label>
          <div class="input-group">
            <input v-model="form.outputDir" class="input" readonly placeholder="选择目录" />
            <button class="btn" @click="pickDir">浏览</button>
          </div>
          <div class="hint">输出到 &lt;目录&gt;/icons/&lt;前缀&gt;_00.png</div>
        </div>

        <button class="btn btn-primary btn-block" style="margin-top: 14px" :disabled="running" @click="start">
          {{ running ? '生成中…' : `生成 ${form.count} 个图标` }}
        </button>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div class="card-title">结果</div>
        <button v-if="result" class="btn btn-sm" @click="reveal">打开目录</button>
      </div>
      <div class="card-body">
        <div v-if="running || progress" style="margin-bottom: 14px">
          <div class="progress-meta">
            <span>{{ progress?.message || '生成中…' }}</span>
            <span>{{ Math.round((progress?.progress ?? 0) * 100) }}%</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" :style="{ width: `${(progress?.progress ?? 0) * 100}%` }" />
          </div>
        </div>

        <div v-if="error" class="alert alert-danger">{{ error }}</div>

        <div v-if="!result && !running" class="empty">生成结果会显示在这里</div>

        <div v-if="result" class="frame-grid">
          <div v-for="f in result.files" :key="f" class="frame-cell">
            <img :src="fileUrl(f)" :alt="f" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
