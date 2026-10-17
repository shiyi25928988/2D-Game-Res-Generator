<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { JobProgressEvent, SpriteJobResult } from '@shared/types'
import { defaultProvider, fileUrl, notify, store } from '../store/app'
import SpritePlayer from '../components/SpritePlayer.vue'

const presets = [
  { name: 'idle', label: '待机 idle', frames: 4, fps: 8, intensity: 'low' as const },
  { name: 'walk', label: '行走 walk', frames: 8, fps: 12, intensity: 'medium' as const },
  { name: 'run', label: '奔跑 run', frames: 6, fps: 14, intensity: 'high' as const },
  { name: 'attack', label: '攻击 attack', frames: 6, fps: 12, intensity: 'high' as const },
  { name: 'hurt', label: '受击 hurt', frames: 3, fps: 10, intensity: 'medium' as const }
]

const form = reactive({
  providerId: '',
  characterName: 'hero',
  stylePrompt: 'pixel art, 16-bit RPG game character, fantasy knight in blue armor, full body',
  negativePrompt: 'blurry, multiple characters, text, watermark, cropped, extra limbs',
  canvasWidth: 128,
  canvasHeight: 128,
  actionPreset: 'walk',
  actionName: 'walk',
  frames: 8,
  fps: 12,
  loop: true,
  intensity: 'medium' as 'low' | 'medium' | 'high',
  seed: -1,
  steps: 24,
  cfgScale: 7,
  removeBackground: true,
  autoAlign: true,
  outputDir: '',
  godotRoot: ''
})

const jobId = ref('')
const running = ref(false)
const progress = ref<JobProgressEvent | null>(null)
const error = ref('')
const result = ref<SpriteJobResult | null>(null)
const exporting = ref(false)
const exportFiles = ref<string[]>([])
const exportWarnings = ref<string[]>([])

const offs: Array<() => void> = []

const stageLabel: Record<string, string> = {
  queued: '排队中',
  'generating-reference': '生成参考母版',
  'generating-frames': '逐帧生成',
  postprocessing: '去底与裁切',
  aligning: '统一对齐',
  validating: '一致性校验',
  exporting: '导出',
  done: '完成',
  failed: '失败',
  cancelled: '已取消'
}

const activeProvider = computed(() => store.providers.find((p) => p.id === form.providerId))

/** 与主进程一致的等级推断，用于生成前提示 */
const level = computed<'A' | 'B' | 'C'>(() => {
  const p = activeProvider.value
  if (!p) return 'C'
  if (p.type === 'sd-webui') {
    return (p.options as { controlnetModel?: string })?.controlnetModel ? 'A' : 'B'
  }
  if (p.type === 'comfyui') return 'B'
  if (p.type === 'openai-compat') {
    return (p.options as { enableImg2Img?: boolean })?.enableImg2Img ? 'B' : 'C'
  }
  return 'C'
})

const levelMeta = computed(() => {
  if (level.value === 'A') {
    return {
      cls: 'badge-ok',
      text: '一致性等级 A · ControlNet 姿态约束',
      desc: '使用 OpenPose 骨架约束每帧姿态，动画一致性最佳。'
    }
  }
  if (level.value === 'B') {
    return {
      cls: 'badge-warn',
      text: '一致性等级 B · 仅 img2img',
      desc: '没有 ControlNet 时，动作幅度大的帧可能出现形变，建议动作幅度设为「低」并减少帧数。'
    }
  }
  return {
    cls: 'badge-danger',
    text: '一致性等级 C · 仅 txt2img',
    desc: '当前服务不支持 img2img，逐帧生成的角色会有明显差异，不建议用于正式素材。'
  }
})

function applyPreset(name: string): void {
  const p = presets.find((x) => x.name === name)
  if (!p) return
  form.actionName = p.name
  form.frames = p.frames
  form.fps = p.fps
  form.intensity = p.intensity
}

watch(
  () => form.actionPreset,
  (v) => applyPreset(v)
)

async function pickOutputDir(): Promise<void> {
  const dir = await window.api.dialog.selectDirectory('选择素材输出目录')
  if (dir) form.outputDir = dir
}

async function pickGodotRoot(): Promise<void> {
  const dir = await window.api.dialog.selectDirectory('选择 Godot 项目根目录')
  if (dir) form.godotRoot = dir
}

async function start(): Promise<void> {
  error.value = ''
  result.value = null
  exportFiles.value = []
  exportWarnings.value = []

  if (!form.providerId) {
    notify('请先选择生图服务', 'error')
    return
  }
  if (!form.outputDir) {
    notify('请选择素材输出目录', 'error')
    return
  }

  running.value = true
  progress.value = null

  try {
    const res = await window.api.generate.sprite({
      projectId: 'local',
      providerId: form.providerId,
      stylePrompt: form.stylePrompt,
      negativePrompt: form.negativePrompt,
      referenceImagePath: undefined,
      canvasWidth: form.canvasWidth,
      canvasHeight: form.canvasHeight,
      removeBackground: form.removeBackground,
      autoAlign: form.autoAlign,
      action: {
        name: form.actionName,
        frames: form.frames,
        fps: form.fps,
        loop: form.loop,
        intensity: form.intensity
      },
      seed: form.seed,
      steps: form.steps,
      cfgScale: form.cfgScale,
      outputDir: form.outputDir,
      characterName: form.characterName
    })
    jobId.value = res.jobId
  } catch (err) {
    running.value = false
    error.value = (err as Error).message
  }
}

async function cancel(): Promise<void> {
  if (jobId.value) await window.api.generate.cancel(jobId.value)
}

function revealAtlas(): void {
  if (result.value) void window.api.exporter.reveal(result.value.atlasPath)
}

async function exportToGodot(): Promise<void> {
  if (!result.value) return
  if (!form.godotRoot) {
    notify('请先选择 Godot 项目根目录', 'error')
    return
  }
  exporting.value = true
  try {
    const res = await window.api.exporter.godot({
      atlasPath: result.value.atlasPath,
      actionName: result.value.action.name,
      fps: result.value.action.fps,
      loop: result.value.action.loop,
      frameWidth: result.value.canvasWidth,
      frameHeight: result.value.canvasHeight,
      frameCount: result.value.frames.length,
      godotProjectRoot: form.godotRoot,
      characterName: result.value.characterName,
      exportJson: true
    })
    exportFiles.value = res.files
    exportWarnings.value = res.warnings
    notify('已导出到 Godot 项目', 'ok')
  } catch (err) {
    notify((err as Error).message, 'error')
  } finally {
    exporting.value = false
  }
}

onMounted(() => {
  form.outputDir = store.defaultOutputDir
  const def = defaultProvider()
  if (def) form.providerId = def.id

  offs.push(
    window.api.providers.onChanged(() => {
      if (!form.providerId && store.providers[0]) form.providerId = store.providers[0].id
    }),
    window.api.generate.onProgress((e) => {
      if (e.jobId === jobId.value) progress.value = e
    }),
    window.api.generate.onFinished((e) => {
      if (e.jobId !== jobId.value || e.kind !== 'sprite') return
      running.value = false
      result.value = e.result
      notify(`生成完成：${e.result.frames.length} 帧`, 'ok')
    }),
    window.api.generate.onFailed((e) => {
      if (e.jobId !== jobId.value || e.kind !== 'sprite') return
      running.value = false
      error.value = e.error
      notify('生成失败', 'error')
    })
  )
})

onBeforeUnmount(() => {
  offs.forEach((off) => off())
})

const framePaths = computed(() => result.value?.frames.map((f) => f.path) ?? [])
const reviewFrames = computed(() => result.value?.frames.filter((f) => f.status === 'needs-review') ?? [])
</script>

<template>
  <div class="page-head">
    <div>
      <h1 class="page-title">精灵动画</h1>
      <p class="page-desc">
        生成带透明通道的动作序列帧，自动对齐后拼接图集，可直接导出为 Godot 的 SpriteFrames 资源。
      </p>
    </div>
    <div v-if="activeProvider" class="badge" :class="levelMeta.cls">{{ levelMeta.text }}</div>
  </div>

  <div v-if="store.providers.length === 0" class="card" style="margin-bottom: 16px">
    <div class="empty">
      还没有配置生图服务。
      <button class="btn btn-sm" style="margin-left: 8px" @click="store.active = 'providers'">
        去配置
      </button>
    </div>
  </div>

  <div class="grid-2">
    <!-- 左：配置 -->
    <div class="card">
      <div class="card-head">
        <div class="card-title">生成配置</div>
      </div>
      <div class="card-body">
        <div class="field">
          <label class="label">生图服务</label>
          <select v-model="form.providerId" class="select">
            <option value="" disabled>选择服务</option>
            <option v-for="p in store.providers" :key="p.id" :value="p.id">
              {{ p.name }}{{ p.isDefault ? '（默认）' : '' }}
            </option>
          </select>
          <div v-if="activeProvider" class="hint">{{ levelMeta.desc }}</div>
        </div>

        <div class="grid-cols-2">
          <div class="field">
            <label class="label">角色名</label>
            <input v-model="form.characterName" class="input" placeholder="hero" />
          </div>
          <div class="field">
            <label class="label">画布尺寸</label>
            <select
              class="select"
              :value="`${form.canvasWidth}x${form.canvasHeight}`"
              @change="(e) => {
                const [w, h] = (e.target as HTMLSelectElement).value.split('x').map(Number)
                form.canvasWidth = w; form.canvasHeight = h
              }"
            >
              <option value="64x64">64 × 64（像素风）</option>
              <option value="96x96">96 × 96</option>
              <option value="128x128">128 × 128（推荐）</option>
              <option value="192x192">192 × 192</option>
              <option value="256x256">256 × 256</option>
            </select>
          </div>
        </div>

        <div class="field">
          <label class="label">风格提示词</label>
          <textarea v-model="form.stylePrompt" class="textarea" rows="3" style="font-family: var(--font); font-size: 12.5px" />
        </div>

        <div class="field">
          <label class="label">负向提示词</label>
          <textarea v-model="form.negativePrompt" class="textarea" rows="2" style="font-family: var(--font); font-size: 12.5px" />
        </div>

        <div class="divider" />

        <div class="grid-cols-2">
          <div class="field">
            <label class="label">动作</label>
            <select v-model="form.actionPreset" class="select">
              <option v-for="p in presets" :key="p.name" :value="p.name">{{ p.label }}</option>
            </select>
          </div>
          <div class="field">
            <label class="label">动作幅度</label>
            <select v-model="form.intensity" class="select">
              <option value="low">低（待机、呼吸）</option>
              <option value="medium">中（行走）</option>
              <option value="high">高（奔跑、攻击）</option>
            </select>
          </div>
          <div class="field">
            <label class="label">帧数</label>
            <input v-model.number="form.frames" type="number" min="2" max="24" class="input" />
          </div>
          <div class="field">
            <label class="label">帧率 FPS</label>
            <input v-model.number="form.fps" type="number" min="1" max="30" class="input" />
          </div>
        </div>

        <div class="field">
          <label class="checkbox">
            <input v-model="form.loop" type="checkbox" />
            循环播放
          </label>
        </div>

        <div class="divider" />

        <div class="grid-cols-2">
          <div class="field">
            <label class="label">随机种子 <span class="hint">-1 为随机</span></label>
            <input v-model.number="form.seed" type="number" class="input" />
          </div>
          <div class="field">
            <label class="label">采样步数</label>
            <input v-model.number="form.steps" type="number" min="4" max="60" class="input" />
          </div>
        </div>

        <div class="field">
          <label class="label">CFG Scale</label>
          <input v-model.number="form.cfgScale" type="number" step="0.5" min="1" max="20" class="input" />
        </div>

        <div class="field">
          <label class="checkbox">
            <input v-model="form.removeBackground" type="checkbox" />
            自动去底（生成透明通道）
          </label>
          <label class="checkbox">
            <input v-model="form.autoAlign" type="checkbox" />
            自动对齐（统一基线、居中）
          </label>
        </div>

        <div class="field">
          <label class="label">素材输出目录</label>
          <div class="input-group">
            <input v-model="form.outputDir" class="input" readonly placeholder="选择目录" />
            <button class="btn" @click="pickOutputDir">浏览</button>
          </div>
          <div class="hint">输出到 &lt;目录&gt;/&lt;角色名&gt;/&lt;动作&gt;.png</div>
        </div>

        <div class="field">
          <label class="label">Godot 项目根目录 <span class="hint">导出时使用</span></label>
          <div class="input-group">
            <input v-model="form.godotRoot" class="input" readonly placeholder="选择 Godot 项目" />
            <button class="btn" @click="pickGodotRoot">浏览</button>
          </div>
        </div>

        <div class="row" style="margin-top: 16px">
          <button class="btn btn-primary btn-block" :disabled="running || !form.providerId" @click="start">
            {{ running ? '生成中…' : `生成 ${form.frames} 帧 ${form.actionName}` }}
          </button>
          <button v-if="running" class="btn" @click="cancel">取消</button>
        </div>
      </div>
    </div>

    <!-- 右：结果 -->
    <div class="card">
      <div class="card-head">
        <div class="card-title">预览与导出</div>
        <div v-if="result" class="badge badge-muted">
          {{ result.providerLevel }} 级 · {{ result.frames.length }} 帧
        </div>
      </div>
      <div class="card-body">
        <!-- 进度 -->
        <div v-if="running || progress" style="margin-bottom: 14px">
          <div class="progress-meta">
            <span>{{ stageLabel[progress?.stage ?? 'queued'] }}</span>
            <span>{{ Math.round((progress?.progress ?? 0) * 100) }}%</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" :style="{ width: `${(progress?.progress ?? 0) * 100}%` }" />
          </div>
          <div class="hint" style="margin-top: 6px">
            {{ progress?.message || '正在准备…' }}
            <span v-if="progress?.totalFrames">（{{ (progress.frameIndex ?? 0) + 1 }}/{{ progress.totalFrames }}）</span>
          </div>
        </div>

        <div v-if="error" class="alert alert-danger" style="margin-bottom: 14px">{{ error }}</div>

        <div v-if="!result && !running" class="empty">
          生成结果会显示在这里
          <div class="hint" style="margin-top: 6px">
            首次生成会先产出一张参考母版，再逐帧生成动作，耗时取决于本地显卡。
          </div>
        </div>

        <template v-if="result">
          <SpritePlayer
            :frames="framePaths"
            :fps="result.action.fps"
            :width="result.canvasWidth"
            :height="result.canvasHeight"
            :loop="result.action.loop"
          />

          <div v-if="result.warnings.length" class="alert alert-warn" style="margin-top: 14px">
            <div>
              <div v-for="(w, i) in result.warnings" :key="i">{{ w }}</div>
            </div>
          </div>

          <div class="divider" />

          <div class="label" style="margin-bottom: 8px">
            序列帧
            <span v-if="reviewFrames.length" class="badge badge-warn">{{ reviewFrames.length }} 帧待复查</span>
          </div>
          <div class="frame-grid">
            <div
              v-for="f in result.frames"
              :key="f.index"
              class="frame-cell"
              :class="{ 'needs-review': f.status === 'needs-review' }"
              :title="f.warnings.join('；')"
            >
              <img :src="fileUrl(f.path)" :alt="`frame ${f.index}`" />
              <div class="frame-index">
                <span>#{{ f.index + 1 }}</span>
                <span v-if="f.status === 'needs-review'" style="color: var(--danger)">!</span>
              </div>
            </div>
          </div>

          <div class="divider" />

          <div class="row">
            <button class="btn btn-primary" :disabled="exporting" @click="exportToGodot">
              {{ exporting ? '导出中…' : '导出到 Godot' }}
            </button>
            <button class="btn" @click="revealAtlas">打开输出目录</button>
            <div class="spacer" />
            <span class="hint">图集：{{ result.atlasPath.split(/[\\/]/).slice(-3).join('/') }}</span>
          </div>

          <div v-if="exportFiles.length" class="section-gap">
            <div class="label" style="margin-bottom: 6px">已导出文件</div>
            <div class="file-list">
              <div v-for="f in exportFiles" :key="f">{{ f }}</div>
            </div>
            <div v-if="exportWarnings.length" class="hint" style="margin-top: 6px">
              {{ exportWarnings.join('；') }}
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
