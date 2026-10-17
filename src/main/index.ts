import { app, BrowserWindow, net, protocol, shell } from 'electron'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'

const isDev = !app.isPackaged

// 允许渲染进程通过 resgen:///<绝对路径> 预览本地生成物
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'resgen',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#f6f7fb',
    title: '2D 游戏美术资源生成器',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // 冒烟测试：CI / 本地验证时确认界面真的渲染出来，然后自动退出
  if (process.env.RESGEN_SMOKE === '1') {
    win.webContents.on('console-message', (_e, level, message) => {
      console.log(`[renderer:${level}] ${message}`)
    })
    win.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        void win.webContents
          .executeJavaScript(
            'JSON.stringify({ title: document.title, text: document.body.innerText.slice(0, 160) })'
          )
          .then(async (info) => {
            console.log('[smoke]', info)
            if (!app.isPackaged) {
              const image = await win.webContents.capturePage()
              await writeFile(join(app.getAppPath(), 'docs', 'preview.png'), image.toPNG())
              console.log('[smoke] 截图已保存到 docs/preview.png')
            }
            app.quit()
          })
      }, 1500)
    })
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error('[smoke] 页面加载失败', code, desc)
      app.quit()
    })
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  protocol.handle('resgen', (request) => {
    try {
      const url = new URL(request.url)
      let filePath = decodeURIComponent(url.pathname)
      if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(filePath)) {
        filePath = filePath.slice(1)
      }
      return net.fetch(pathToFileURL(filePath).toString())
    } catch (err) {
      return new Response(`读取本地文件失败：${(err as Error).message}`, { status: 400 })
    }
  })

  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
