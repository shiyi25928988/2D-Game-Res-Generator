import sharp from 'sharp'
import { writeFileSync, mkdirSync } from 'node:fs'

const S = 512
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#243044"/>
      <stop offset="1" stop-color="#0f1620"/>
    </linearGradient>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7dd3fc"/>
      <stop offset="1" stop-color="#38bdf8"/>
    </linearGradient>
  </defs>

  <rect x="0" y="0" width="512" height="512" rx="112" fill="url(#bg)"/>
  <rect x="16" y="16" width="480" height="480" rx="100" fill="none" stroke="#38bdf8" stroke-opacity="0.18" stroke-width="2"/>

  <!-- 运动残影：暗示逐帧动画 -->
  <g opacity="0.16" fill="#7dd3fc">
    <rect x="150" y="196" width="84" height="84" rx="12"/>
    <rect x="150" y="300" width="120" height="26" rx="10"/>
  </g>
  <g opacity="0.3" fill="#7dd3fc">
    <rect x="192" y="186" width="92" height="92" rx="14"/>
    <rect x="186" y="290" width="132" height="28" rx="11"/>
  </g>

  <!-- 主体：像素小人 -->
  <g>
    <rect x="238" y="150" width="84" height="84" rx="14" fill="url(#body)"/>
    <rect x="258" y="180" width="12" height="16" rx="3" fill="#0f1620"/>
    <rect x="290" y="180" width="12" height="16" rx="3" fill="#0f1620"/>
    <rect x="262" y="212" width="36" height="8" rx="4" fill="#0f1620" opacity="0.7"/>

    <rect x="246" y="246" width="68" height="84" rx="14" fill="#e2e8f0"/>
    <rect x="258" y="264" width="44" height="10" rx="5" fill="#94a3b8" opacity="0.7"/>
    <rect x="258" y="284" width="44" height="10" rx="5" fill="#94a3b8" opacity="0.45"/>

    <rect x="228" y="252" width="16" height="64" rx="8" fill="#e2e8f0"/>
    <rect x="316" y="252" width="16" height="64" rx="8" fill="#e2e8f0"/>

    <rect x="258" y="336" width="18" height="58" rx="8" fill="#e2e8f0"/>
    <rect x="286" y="336" width="18" height="58" rx="8" fill="#e2e8f0"/>
  </g>

  <!-- 帧标记：底部三段 -->
  <g fill="#38bdf8" opacity="0.85">
    <rect x="186" y="418" width="40" height="8" rx="4"/>
    <rect x="236" y="418" width="40" height="8" rx="4" opacity="0.55"/>
    <rect x="286" y="418" width="40" height="8" rx="4" opacity="0.3"/>
  </g>
</svg>`

mkdirSync('build', { recursive: true })
const png = await sharp(Buffer.from(svg)).png().toBuffer()
writeFileSync('build/icon.png', png)

// ICO 容器（Vista+ 支持内嵌 PNG），逐尺寸打包
const sizes = [256, 128, 64, 48, 32, 16]
const images = []
for (const s of sizes) {
  images.push({ size: s, data: await sharp(Buffer.from(svg)).resize(s, s).png().toBuffer() })
}

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(images.length, 4)

const dir = Buffer.alloc(16 * images.length)
let offset = 6 + dir.length
images.forEach((img, i) => {
  const p = i * 16
  dir.writeUInt8(img.size >= 256 ? 0 : img.size, p)
  dir.writeUInt8(img.size >= 256 ? 0 : img.size, p + 1)
  dir.writeUInt8(0, p + 2)
  dir.writeUInt8(0, p + 3)
  dir.writeUInt16LE(1, p + 4)
  dir.writeUInt16LE(32, p + 6)
  dir.writeUInt32LE(img.data.length, p + 8)
  dir.writeUInt32LE(offset, p + 12)
  offset += img.data.length
})

writeFileSync('build/icon.ico', Buffer.concat([header, dir, ...images.map((i) => i.data)]))
console.log('生成 build/icon.png 与 build/icon.ico')
