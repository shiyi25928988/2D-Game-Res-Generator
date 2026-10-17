/// <reference types="vite/client" />

import type { AppApi } from '@shared/api'

declare global {
  interface Window {
    api: AppApi
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

export {}
