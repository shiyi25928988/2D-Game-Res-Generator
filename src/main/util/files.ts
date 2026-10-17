import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { randomUUID } from 'node:crypto'

export function ensureDirSync(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export async function ensureDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * 每次任务独立目录，避免生成物互相覆盖。
 * 允许用 RESGEN_TEMP_DIR 覆盖，以便在 Electron 之外跑端到端测试。
 */
export function jobTempDir(jobId: string): string {
  const base = process.env.RESGEN_TEMP_DIR || join(app.getPath('temp'), 'resgen')
  return join(base, jobId)
}

export async function saveBase64Image(b64: string, dir: string, prefix: string): Promise<string> {
  await ensureDir(dir)
  const clean = b64.replace(/^data:image\/\w+;base64,/, '')
  const file = join(dir, `${prefix}-${randomUUID().slice(0, 8)}.png`)
  await writeFile(file, Buffer.from(clean, 'base64'))
  return file
}

export async function saveBufferImage(
  buf: Buffer,
  dir: string,
  prefix: string,
  ext = '.png'
): Promise<string> {
  await ensureDir(dir)
  const file = join(dir, `${prefix}-${randomUUID().slice(0, 8)}${ext}`)
  await writeFile(file, buf)
  return file
}

export async function fileToBase64(filePath: string): Promise<string> {
  const buf = await readFile(filePath)
  return buf.toString('base64')
}

export function assertImagePath(filePath: string): void {
  const ext = extname(filePath).toLowerCase()
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    throw new Error(`不支持的图片格式：${ext}`)
  }
}
