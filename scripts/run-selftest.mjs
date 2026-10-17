/**
 * 用 esbuild 把 TS 自检脚本打包成 CJS 后执行。
 * 这样无需给主进程代码额外配置运行器，也不会把测试逻辑带进构建产物。
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = join(root, '.tmp', 'selftest.cjs')

mkdirSync(join(root, '.tmp'), { recursive: true })

await build({
  entryPoints: [join(root, 'scripts', 'selftest.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['sharp'],
  alias: { '@shared': join(root, 'src', 'shared') },
  outfile
})

const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit', cwd: root })
process.exit(result.status ?? 1)
