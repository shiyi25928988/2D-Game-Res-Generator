<script setup lang="ts">
import { onMounted } from 'vue'
import { store, initStore, type ViewKey } from './store/app'
import SpriteView from './views/SpriteView.vue'
import IconsView from './views/IconsView.vue'
import ProvidersView from './views/ProvidersView.vue'

const nav: Array<{ key: ViewKey; label: string; icon: string }> = [
  {
    key: 'sprite',
    label: '精灵动画',
    icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="3.5" width="5" height="9" rx="1.2" stroke="currentColor" stroke-width="1.3"/><rect x="9.5" y="3.5" width="5" height="9" rx="1.2" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 2"/></svg>'
  },
  {
    key: 'icons',
    label: '图标生成',
    icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1.8l2.2 4.1 4.3.7-3.1 3 .7 4.4L8 12l-4.1 2l.7-4.4-3.1-3l4.3-.7L8 1.8z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>'
  },
  {
    key: 'providers',
    label: '生图服务',
    icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 5h8M12 5h2M2 11h3M7 11h7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="11" cy="5" r="1.7" stroke="currentColor" stroke-width="1.3"/><circle cx="6" cy="11" r="1.7" stroke="currentColor" stroke-width="1.3"/></svg>'
  }
]

onMounted(() => {
  void initStore()
})
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">2D</div>
        <div>
          <div class="brand-title">美术资源生成器</div>
          <div class="brand-sub">Sprite · Icon · Godot</div>
        </div>
      </div>

      <nav class="nav">
        <button
          v-for="item in nav"
          :key="item.key"
          class="nav-item"
          :class="{ active: store.active === item.key }"
          @click="store.active = item.key"
        >
          <span class="nav-icon" v-html="item.icon" />
          {{ item.label }}
        </button>
      </nav>

      <div class="sidebar-footer">
        <div class="row" style="gap: 6px">
          <span class="status-dot" :class="store.providers.length ? 'dot-ok' : 'dot-off'" />
          <span>{{ store.providers.length }} 个生图服务</span>
        </div>
        <div>v{{ store.appVersion || '0.1.0' }}</div>
      </div>
    </aside>

    <main class="main">
      <SpriteView v-if="store.active === 'sprite'" />
      <IconsView v-else-if="store.active === 'icons'" />
      <ProvidersView v-else />
    </main>

    <transition name="fade">
      <div v-if="store.toast" class="toast" :class="`toast-${store.toastKind}`">
        {{ store.toast }}
      </div>
    </transition>
  </div>
</template>

<style scoped>
.toast {
  position: fixed;
  bottom: 22px;
  left: 50%;
  transform: translateX(-50%);
  padding: 9px 16px;
  border-radius: 8px;
  font-size: 12.5px;
  box-shadow: var(--shadow-md);
  z-index: 90;
  max-width: 70vw;
  background: #23273a;
  color: #fff;
}

.toast-ok {
  background: #136c46;
}

.toast-error {
  background: #a52f2f;
}
</style>
