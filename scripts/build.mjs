#!/usr/bin/env node
/**
 * 一键编译脚本
 *
 *   node scripts/build.mjs             # 类型检查 + 构建 + 便携版 exe + 安装包 exe
 *   node scripts/build.mjs --dir       # 只出未打包目录（最快，用于本地验证）
 *   node scripts/build.mjs --portable  # 只出便携版单文件 exe
 *   node scripts/build.mjs --nsis      # 只出安装包 exe
 *   node scripts/build.mjs --all       # 未打包目录 + 便携版 + 安装包
 *
 * 国内网络自动走镜像；Windows 下自动修复 electron-builder 工具链的符号链接问题。
 * Windows 用户也可直接双击 build.bat。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'out')
const RELEASE_DIR = join(ROOT, 'release')
const TOOLS_DIR = join(process.env.LOCALAPPDATA || join(os.homedir(), '.cache'), 'resgen-build-tools')
const NPM_MIRROR = 'https://registry.npmmirror.com/-/binary/'
const EB_UPSTREAM = `${NPM_MIRROR}electron-builder-binaries/`

const HELP = `
用法: node scripts/build.mjs [选项]

目标（可组合，默认 --portable + --nsis，两者都产出 exe）
  --dir          生成未打包目录 release/win-unpacked（最快，用于验证）
  --nsis         生成安装包 exe（ResGen-<版本>-setup.exe）
  --portable     生成便携版单文件 exe（双击即用，免安装）
  --all          三者全出

选项
  --cn           使用 npmmirror 镜像并自动修复 Windows 工具链（默认开启）
  --no-cn        直连 GitHub，不做本地镜像修复
  --proxy=URL    为下载步骤指定代理，如 --proxy=http://127.0.0.1:7897
  --no-typecheck 跳过 TypeScript 类型检查
  --keep-out     复用已有的 out/，不重新构建
  --out=DIR      指定产物目录（默认 release）
  -h, --help     显示帮助
`.trim()

/* ---------------------------------------------------------------- 参数与工具 */

function parseArgs(argv) {
  const opts = { targets: new Set(), typecheck: true, vite: true, cn: true, proxy: '', out: '', help: false }
  for (const arg of argv) {
    switch (arg) {
      case '--dir':
        opts.targets.add('dir')
        break
      case '--nsis':
      case '--installer':
        opts.targets.add('nsis')
        break
      case '--portable':
      case '--exe':
        opts.targets.add('portable')
        break
      case '--all':
        ;['dir', 'nsis', 'portable'].forEach((t) => opts.targets.add(t))
        break
      case '--cn':
        opts.cn = true
        break
      case '--no-cn':
        opts.cn = false
        break
      case '--no-typecheck':
        opts.typecheck = false
        break
      case '--keep-out':
        opts.vite = false
        break
      case '-h':
      case '--help':
        opts.help = true
        break
      default:
        if (arg.startsWith('--proxy=')) opts.proxy = arg.slice('--proxy='.length)
        else if (arg.startsWith('--out=')) opts.out = arg.slice('--out='.length)
        else if (arg.startsWith('--')) fail(`未知选项 ${arg}（--help 查看用法）`)
    }
  }
  // 默认直接交付 exe：便携版（双击即用）+ 安装包
  if (opts.targets.size === 0) {
    opts.targets.add('portable')
    opts.targets.add('nsis')
  }
  return opts
}

function fail(msg) {
  console.error(`\n[失败] ${msg}`)
  process.exit(1)
}

function log(msg) {
  console.log(msg)
}

function step(no, total, msg) {
  console.log(`\n[${no}/${total}] ${msg}`)
}

function human(bytes) {
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

function childEnv(opts, extra = {}) {
  const env = { ...process.env }
  // 该变量会让 Electron 退化成纯 Node，必须剔除
  delete env.ELECTRON_RUN_AS_NODE
  if (opts.cn) {
    env.ELECTRON_MIRROR ??= `${NPM_MIRROR}electron/`
    env.ELECTRON_BUILDER_BINARIES_MIRROR ??= EB_UPSTREAM
  }
  if (opts.proxy) {
    env.HTTP_PROXY = env.HTTPS_PROXY = env.http_proxy = env.https_proxy = opts.proxy
  }
  // 本地工具链镜像必须绕过代理，否则请求会被系统代理劫持（Go / curl 都不会自动放行 localhost）
  const bypass = 'localhost,127.0.0.1,::1'
  env.NO_PROXY = env.no_proxy = env.NO_PROXY ? `${env.NO_PROXY},${bypass}` : bypass
  return { ...env, ...extra }
}

function runNode(scriptPath, args, opts, label, extraEnv) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: childEnv(opts, extraEnv)
  })
  if (res.error) fail(`${label} 启动失败：${res.error.message}`)
  if (res.status !== 0) fail(`${label} 失败（退出码 ${res.status}）`)
}

function runExe(exe, args, cwd = ROOT) {
  return spawnSync(exe, args, { cwd, stdio: 'ignore', windowsHide: true })
}

// 本项目未触碰用户个人文件，这里的清理目标都是构建产物，且优先走系统删除命令，
// 避免个别环境里 Node 的删除 API 被替换成「移入回收站」而失败。
function removeDir(dir) {
  if (!existsSync(dir)) return true
  for (let i = 0; i < 3; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 可能被占用，下面换系统命令再试 */
    }
    if (!existsSync(dir)) return true

    if (process.platform === 'win32') runExe('cmd.exe', ['/c', 'rmdir', '/s', '/q', dir])
    else runExe('rm', ['-rf', dir])
    if (!existsSync(dir)) return true
  }
  return !existsSync(dir)
}

/* ------------------------------------------------------ 工具链（rcedit） */

function sevenZipPath() {
  const base = join(ROOT, 'node_modules', '7zip-bin')
  const map = { win32: 'win/x64/7za.exe', darwin: 'mac/arm64/7za', linux: 'linux/x64/7za' }
  const p = join(base, map[process.platform] ?? map.linux)
  if (existsSync(p)) return p
  const fallback = join(base, 'linux', 'x64', '7za')
  return existsSync(fallback) ? fallback : null
}

const RCEDIT_PATH = join(TOOLS_DIR, 'rcedit-x64.exe')

/**
 * 应用图标与版本信息由 after-pack 钩子用 rcedit 写入（见 scripts/after-pack.cjs）。
 * rcedit 包含在 electron-builder 的 winCodeSign 工具链里，但完整解压会因内含的
 * macOS 符号链接在普通 Windows 账户上失败，这里只单独解出 rcedit 一个文件。
 */
async function ensureRcedit() {
  if (existsSync(RCEDIT_PATH)) return true
  const sevenZip = sevenZipPath()
  if (!sevenZip) return false

  mkdirSync(TOOLS_DIR, { recursive: true })
  const raw = join(TOOLS_DIR, 'winCodeSign-2.6.0.7z')
  if (!existsSync(raw)) {
    log('  · 下载构建工具 rcedit（仅首次需要，约 5.6 MB）')
    const res = await fetch(`${EB_UPSTREAM}winCodeSign-2.6.0/winCodeSign-2.6.0.7z`, { redirect: 'follow' })
    if (!res.ok) return false
    writeFileSync(raw, Buffer.from(await res.arrayBuffer()))
  }
  runExe(sevenZip, ['e', raw, `-o${TOOLS_DIR}`, 'rcedit-x64.exe', '-y'])
  return existsSync(RCEDIT_PATH)
}

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(HELP)
    return
  }

  const major = Number(process.versions.node.split('.')[0])
  if (major < 18) fail(`需要 Node.js 18+，当前 ${process.versions.node}`)
  if (!existsSync(join(ROOT, 'node_modules', 'electron-builder'))) fail('依赖未安装，请先执行：npm install')
  if (!opts.vite && !existsSync(join(OUT_DIR, 'main', 'index.js'))) {
    fail('out/ 不存在或不完整，去掉 --keep-out 重新构建')
  }

  // after-pack 钩子用 rcedit 写图标 / 版本信息，缺失时打包仍会继续（仅无图标）
  if (process.platform === 'win32') {
    const ok = await ensureRcedit()
    log(ok ? '· rcedit 就绪，将写入应用图标与版本信息' : '· 警告：rcedit 准备失败，产物将没有自定义图标与版本信息')
  }

  const tv = opts.targets
  const jobs = ['clean']
  if (opts.vite) jobs.push('vite')
  if (opts.vite && opts.typecheck) jobs.push('typecheck')
  ;['dir', 'nsis', 'portable'].forEach((t) => tv.has(t) && jobs.push(`pack:${t}`))

  let i = 0
  const total = jobs.length
  let outputDir = opts.out ? resolve(ROOT, opts.out) : RELEASE_DIR

  console.log('=== 2D 游戏美术资源生成器 · 编译 ===')
  console.log(`目标: ${[...tv].join(' + ')}${opts.cn ? '（镜像模式）' : ''}`)

  step(++i, total, '清理上次构建产物')
  if (opts.vite && !removeDir(OUT_DIR)) fail(`无法清理 ${OUT_DIR}，请关闭占用该目录的程序`)
  if (existsSync(outputDir) && !removeDir(outputDir)) {
    // 目录被占用（程序未退出 / 杀毒软件扫描）时换目录输出，不让整个编译白跑
    const fallback = resolve(ROOT, `release-${stamp()}`)
    log(`  · ${relative(ROOT, outputDir)} 被占用，本次产物输出到 ${relative(ROOT, fallback)}`)
    outputDir = fallback
  }

    if (opts.vite && opts.typecheck) {
      step(++i, total, '类型检查（主进程 + 渲染进程）')
      runNode(join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), ['--noEmit', '-p', 'tsconfig.node.json'], opts, '主进程类型检查')
      runNode(join(ROOT, 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js'), ['--noEmit', '-p', 'tsconfig.web.json'], opts, '渲染进程类型检查')
    }

    if (opts.vite) {
      step(++i, total, '构建主进程 / 预加载 / 渲染页面')
      runNode(join(ROOT, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), ['build'], opts, 'electron-vite build')
    }

    const builder = join(ROOT, 'node_modules', 'electron-builder', 'cli.js')
    const packJobs = [
      ['dir', ['--dir'], '生成未打包目录'],
      ['nsis', ['--win', 'nsis'], '打 NSIS 安装包'],
      ['portable', ['--win', 'portable'], '打便携版']
    ]
    for (const [key, args, label] of packJobs) {
      if (!tv.has(key)) continue
      step(++i, total, label)
      runNode(builder, [...args, `-c.directories.output=${outputDir}`], opts, label)
    }

  // 汇总产物：优先把可交付的 exe 单独列出来（绝对路径，便于直接复制）
  console.log('\n=== 编译完成 ===')
  if (!existsSync(outputDir)) {
    console.log('未生成产物，请检查上方日志')
    return
  }

  const entries = readdirSync(outputDir).map((name) => {
    const p = join(outputDir, name)
    const st = statSync(p)
    return { name, size: st.isDirectory() ? null : st.size, dir: st.isDirectory() }
  })
  for (const e of entries.sort((a, b) => Number(a.dir) - Number(b.dir))) {
    if (e.dir) console.log(`  [目录] ${e.name}/`)
    else if (!e.name.toLowerCase().endsWith('.exe')) console.log(`  [文件] ${e.name}  (${human(e.size)})`)
  }

  const exes = entries
    .filter((e) => !e.dir && e.name.toLowerCase().endsWith('.exe'))
    .sort((a, b) => b.size - a.size)

  if (exes.length > 0) {
    console.log('\n可执行文件（.exe）:')
    for (const e of exes) {
      const kind = /setup/i.test(e.name) ? '安装包' : /portable/i.test(e.name) ? '便携版' : '可执行文件'
      console.log(`  ✓ ${kind}: ${join(outputDir, e.name)}  (${human(e.size)})`)
    }
    console.log('\n便携版直接双击即可运行，无需安装；安装包会创建开始菜单与桌面快捷方式。')
  } else if (tv.has('dir')) {
    console.log('\n本次只生成了未打包目录，exe 位于 win-unpacked/ 内；需要分发用 exe 请去掉 --dir 重跑。')
  } else {
    console.log('\n[警告] 未找到 exe 产物，请检查上方打包日志')
  }

  console.log(`\n产物目录: ${outputDir}`)
}

main().catch((err) => fail(err?.stack || String(err)))
