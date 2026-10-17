/**
 * electron-builder afterPack 钩子
 *
 * electron-builder 自带的 rcedit 步骤需要下载 winCodeSign 工具链，
 * 其中包含 macOS 符号链接，普通 Windows 账户无法解压。所以打包配置里
 * 关闭了 signAndEditExecutable，改由本钩子用独立的 rcedit 补写：
 *   - 应用图标（build/icon.ico）
 *   - 版本信息（文件版本 / 产品名 / 版权等）
 */
const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

function findRcedit() {
  const candidates = [
    process.env.RESGEN_RCEDIT,
    join(process.env.LOCALAPPDATA || '', 'resgen-build-tools', 'rcedit-x64.exe')
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) || null
}

exports.default = async function afterPack(context) {
  const exePath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
  if (!existsSync(exePath)) return

  const rcedit = findRcedit()
  if (!rcedit) {
    console.warn('  · 跳过图标与版本信息写入（未找到 rcedit，可重新运行编译脚本自动下载）')
    return
  }

  const info = context.packager.appInfo
  const exeName = `${info.productFilename}.exe`
  const res = spawnSync(
    rcedit,
    [
      exePath,
      '--set-icon', join(__dirname, '..', 'build', 'icon.ico'),
      '--set-file-version', info.version,
      '--set-product-version', info.version,
      '--set-version-string', 'FileDescription', info.productName,
      '--set-version-string', 'ProductName', info.productName,
      '--set-version-string', 'CompanyName', '2D-Game-Res-Generator',
      '--set-version-string', 'LegalCopyright', info.copyright,
      '--set-version-string', 'OriginalFilename', exeName
    ],
    { stdio: 'inherit', windowsHide: true }
  )
  if (res.status !== 0) throw new Error(`rcedit 写入失败（退出码 ${res.status}）`)
  console.log(`  · 已写入图标与版本信息 -> ${exeName}`)
}
