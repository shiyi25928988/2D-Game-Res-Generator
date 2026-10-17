<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fileUrl } from '../store/app'

const props = withDefaults(
  defineProps<{
    frames: string[]
    fps: number
    width: number
    height: number
    loop?: boolean
  }>(),
  { loop: true }
)

const canvasRef = ref<HTMLCanvasElement | null>(null)
const playing = ref(true)
const index = ref(0)
const onion = ref(false)
const images = ref<HTMLImageElement[]>([])

let rafId = 0
let lastTime = 0
let acc = 0

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`图片加载失败：${src}`))
    img.src = fileUrl(src)
  })
}

async function loadAll(list: string[]): Promise<void> {
  try {
    images.value = await Promise.all(list.map(loadImage))
    index.value = 0
    draw()
  } catch {
    images.value = []
  }
}

function draw(): void {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  canvas.width = props.width
  canvas.height = props.height
  ctx.clearRect(0, 0, props.width, props.height)

  const current = images.value[index.value]
  if (onion.value) {
    const prev = images.value[(index.value - 1 + images.value.length) % images.value.length]
    if (prev && images.value.length > 1) {
      ctx.globalAlpha = 0.25
      ctx.drawImage(prev, 0, 0, props.width, props.height)
      ctx.globalAlpha = 1
    }
  }
  if (current) ctx.drawImage(current, 0, 0, props.width, props.height)
}

function tick(time: number): void {
  if (!playing.value) {
    rafId = requestAnimationFrame(tick)
    return
  }
  if (!lastTime) lastTime = time
  acc += time - lastTime
  lastTime = time

  const interval = 1000 / Math.max(1, props.fps)
  if (acc >= interval) {
    acc = 0
    const total = images.value.length
    if (total > 0) {
      if (index.value + 1 >= total) {
        index.value = props.loop ? 0 : total - 1
        if (!props.loop) playing.value = false
      } else {
        index.value += 1
      }
      draw()
    }
  }
  rafId = requestAnimationFrame(tick)
}

function togglePlay(): void {
  playing.value = !playing.value
  lastTime = 0
}

function step(delta: number): void {
  const total = images.value.length
  if (!total) return
  playing.value = false
  index.value = (index.value + delta + total) % total
  draw()
}

watch(
  () => props.frames,
  (list) => {
    void loadAll(list)
  },
  { immediate: true, deep: true }
)

watch([() => props.width, () => props.height], draw)

onMounted(() => {
  draw()
  rafId = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
})
</script>

<template>
  <div class="player">
    <div class="stage" :style="{ minHeight: `${Math.min(340, height + 32)}px` }">
      <canvas
        ref="canvasRef"
        :style="{ width: `${Math.min(300, width)}px`, height: `${Math.min(300, width) * (height / width)}px` }"
      />
    </div>

    <div class="controls">
      <button class="btn btn-sm" @click="step(-1)">◀</button>
      <button class="btn btn-sm" style="min-width: 52px" @click="togglePlay">
        {{ playing ? '暂停' : '播放' }}
      </button>
      <button class="btn btn-sm" @click="step(1)">▶</button>

      <input
        class="slider"
        type="range"
        min="0"
        :max="Math.max(0, frames.length - 1)"
        :value="index"
        @input="(e) => { index = Number((e.target as HTMLInputElement).value); playing = false; draw() }"
      />

      <span class="mono" style="min-width: 46px; text-align: right">
        {{ index + 1 }}/{{ frames.length }}
      </span>

      <label class="checkbox" style="margin-left: 4px">
        <input v-model="onion" type="checkbox" @change="draw" />
        洋葱皮
      </label>
    </div>

    <div class="meta-row">
      <span>{{ width }} × {{ height }}</span>
      <span>·</span>
      <span>{{ fps }} FPS</span>
      <span>·</span>
      <span>{{ loop ? '循环' : '单次' }}</span>
    </div>
  </div>
</template>

<style scoped>
.player {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.controls {
  display: flex;
  align-items: center;
  gap: 6px;
}

.slider {
  flex: 1;
  accent-color: var(--accent);
  height: 4px;
}

.meta-row {
  display: flex;
  gap: 6px;
  font-size: 11.5px;
  color: var(--muted);
}
</style>
