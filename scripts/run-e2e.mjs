/**
 * 打包并执行端到端测试。
 * 与 selftest 复用同一套 esbuild 打包方式，避免主进程代码依赖 Electron 运行时。
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = join(root, '.tmp', 'e2e.cjs')

mkdirSync(join(root, '.tmp'), { recursive: true })

await build({
  entryPoints: [join(root, 'scripts', 'e2e.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['sharp', 'electron'],
  alias: { '@shared': join(root, 'src', 'shared') },
  outfile,
  logLevel: 'warning'
})

const result = spawnSync(process.execPath, [outfile], {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env, RESGEN_TEMP_DIR: join(root, '.tmp', 'e2e-temp') }
})
process.exit(result.status ?? 1)
