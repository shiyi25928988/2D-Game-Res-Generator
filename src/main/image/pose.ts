import sharp from 'sharp'
import { writeFile } from 'node:fs/promises'

/**
 * 程序化姿态骨架生成。
 * 输出符合 OpenPose 配色约定的骨骼图，供本地 SD 的 ControlNet(openpose) 使用，
 * 用于约束动画各帧的姿态，解决「每帧角色都不一样」的核心问题。
 */

interface Point {
  x: number
  y: number
}

interface Skeleton {
  nose: Point
  neck: Point
  rShoulder: Point
  rElbow: Point
  rWrist: Point
  lShoulder: Point
  lElbow: Point
  lWrist: Point
  rHip: Point
  rKnee: Point
  rAnkle: Point
  lHip: Point
  lKnee: Point
  lAnkle: Point
  rEye: Point
  lEye: Point
}

/** OpenPose 官方 18 点配色（取常用的肢体部分） */
const COLORS = {
  nose: '#ff0000',
  neck: '#ff5500',
  rShoulder: '#ffaa00',
  rElbow: '#ffff00',
  rWrist: '#aaff00',
  lShoulder: '#55ff00',
  lElbow: '#00ff00',
  lWrist: '#00ff55',
  rHip: '#00ffaa',
  rKnee: '#00ffff',
  rAnkle: '#00aaff',
  lHip: '#0055ff',
  lKnee: '#0000ff',
  lAnkle: '#5500ff',
  rEye: '#aa00ff',
  lEye: '#ff00ff'
}

const deg = (d: number): number => (d * Math.PI) / 180

/** 从关节出发按「与竖直向下方向的夹角」求下一点 */
function extend(from: Point, length: number, angleDeg: number): Point {
  const a = deg(angleDeg)
  return { x: from.x + Math.sin(a) * length, y: from.y + Math.cos(a) * length }
}

function tween(from: number, to: number, t: number): number {
  return from + (to - from) * t
}

function buildSkeleton(action: string, frame: number, total: number, w: number, h: number): Skeleton {
  const phase = (frame / Math.max(1, total)) * Math.PI * 2
  const cx = w / 2
  const isIdle = action === 'idle'
  const isAttack = action === 'attack'
  const amplitude = isIdle ? 8 : 24

  const bob = isIdle ? Math.sin(phase) * h * 0.008 : Math.abs(Math.sin(phase)) * h * 0.02

  const hipY = h * 0.5 + bob
  const shoulderY = h * 0.24 + bob
  const torso = hipY - shoulderY
  const thigh = h * 0.22
  const shin = h * 0.22
  const upperArm = h * 0.13
  const lowerArm = h * 0.13

  // 腿部：左右反相摆动
  const legL = amplitude * Math.sin(phase)
  const legR = amplitude * Math.sin(phase + Math.PI)
  const kneeBendL = Math.max(0, -Math.sin(phase)) * 35
  const kneeBendR = Math.max(0, -Math.sin(phase + Math.PI)) * 35

  const lHip = { x: cx + w * 0.045, y: hipY }
  const rHip = { x: cx - w * 0.045, y: hipY }

  const lKnee = extend(lHip, thigh, legL)
  const lAnkle = extend(lKnee, shin, legL - kneeBendL)
  const rKnee = extend(rHip, thigh, legR)
  const rAnkle = extend(rKnee, shin, legR - kneeBendR)

  // 手臂
  let armL = -legL * 0.7
  let armR = -legR * 0.7
  let elbowL = 15
  let elbowR = 15
  if (isIdle) {
    armL = 6 + Math.sin(phase) * 2
    armR = -6 - Math.sin(phase) * 2
    elbowL = 8
    elbowR = 8
  }
  if (isAttack) {
    const t = frame / Math.max(1, total - 1)
    // 蓄力 → 挥出 → 收势
    const swing = t < 0.4 ? tween(-110, -140, t / 0.4) : tween(-140, 35, (t - 0.4) / 0.6)
    armR = swing
    armL = -swing * 0.35
    elbowR = swing > 0 ? 10 : 55
    elbowL = 40
  }

  const lShoulder = { x: cx + w * 0.055, y: shoulderY }
  const rShoulder = { x: cx - w * 0.055, y: shoulderY }
  const lElbow = extend(lShoulder, upperArm, armL)
  const lWrist = extend(lElbow, lowerArm, armL + elbowL)
  const rElbow = extend(rShoulder, upperArm, armR)
  const rWrist = extend(rElbow, lowerArm, armR + elbowR)

  const nose = { x: cx, y: shoulderY - torso * 0.62 }
  return {
    nose,
    neck: { x: cx, y: shoulderY },
    rShoulder,
    rElbow,
    rWrist,
    lShoulder,
    lElbow,
    lWrist,
    rHip,
    rKnee,
    rAnkle,
    lHip,
    lKnee,
    lAnkle,
    rEye: { x: nose.x - w * 0.012, y: nose.y - h * 0.008 },
    lEye: { x: nose.x + w * 0.012, y: nose.y - h * 0.008 }
  }
}

const LIMBS: Array<[keyof Skeleton, keyof Skeleton, string]> = [
  ['nose', 'neck', COLORS.neck],
  ['neck', 'rShoulder', COLORS.rShoulder],
  ['rShoulder', 'rElbow', COLORS.rElbow],
  ['rElbow', 'rWrist', COLORS.rWrist],
  ['neck', 'lShoulder', COLORS.lShoulder],
  ['lShoulder', 'lElbow', COLORS.lElbow],
  ['lElbow', 'lWrist', COLORS.lWrist],
  ['neck', 'rHip', COLORS.rHip],
  ['rHip', 'rKnee', COLORS.rKnee],
  ['rKnee', 'rAnkle', COLORS.rAnkle],
  ['neck', 'lHip', COLORS.lHip],
  ['lHip', 'lKnee', COLORS.lKnee],
  ['lKnee', 'lAnkle', COLORS.lAnkle],
  ['nose', 'rEye', COLORS.rEye],
  ['nose', 'lEye', COLORS.lEye]
]

export function renderPoseSvg(
  action: string,
  frame: number,
  total: number,
  width: number,
  height: number
): string {
  const sk = buildSkeleton(action, frame, total, width, height)
  const limbWidth = Math.max(3, Math.round(Math.min(width, height) * 0.022))
  const jointR = Math.max(2, Math.round(Math.min(width, height) * 0.012))

  const lines = LIMBS.map(([a, b, color]) => {
    const p1 = sk[a]
    const p2 = sk[b]
    return `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" stroke="${color}" stroke-width="${limbWidth}" stroke-linecap="round"/>`
  }).join('')

  const joints = (Object.keys(sk) as Array<keyof Skeleton>)
    .map((k) => {
      const p = sk[k]
      return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${jointR}" fill="${COLORS[k as keyof typeof COLORS] ?? '#ffffff'}"/>`
    })
    .join('')

  // 头部用圆形轮廓辅助模型把头画正
  const headR = Math.min(width, height) * 0.075
  const head = `<circle cx="${sk.nose.x.toFixed(1)}" cy="${(sk.nose.y - headR * 0.5).toFixed(1)}" r="${headR.toFixed(1)}" fill="none" stroke="#ff5500" stroke-width="${limbWidth}"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#000000"/>
  ${head}${lines}${joints}
</svg>`
}

export async function renderPosePng(
  action: string,
  frame: number,
  total: number,
  width: number,
  height: number,
  outPath: string
): Promise<string> {
  const svg = renderPoseSvg(action, frame, total, width, height)
  await sharp(Buffer.from(svg)).png().toFile(outPath)
  return outPath
}

/** 用于没有 ControlNet 时的兜底：直接写一张占位图，不参与生成 */
export async function writeBlankPose(width: number, height: number, outPath: string): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#000"/></svg>`
  await writeFile(outPath, svg)
  return outPath
}
