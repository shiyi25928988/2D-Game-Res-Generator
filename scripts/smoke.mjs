/**
 * 启动一次应用做渲染冒烟测试，加载完成后自动退出。
 * 需要先执行 npm run build。
 * 部分环境会设置 ELECTRON_RUN_AS_NODE，这里显式清除，否则 Electron 会以纯 Node 模式运行。
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBinary = require('electron')

const env = { ...process.env, RESGEN_SMOKE: '1' }
delete env.ELECTRON_RUN_AS_NODE

const result = spawnSync(electronBinary, ['.'], { cwd: root, stdio: 'inherit', env })
process.exit(result.status ?? 1)
