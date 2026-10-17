// 数字の書き方・色・グラフの目盛り。旧サイト（RKMusic_AllSinger_PFR）と同じ計算

export function diffColor(diff: number | null): string {
  if (diff === null) return 'var(--muted)'
  return diff > 0 ? 'var(--up)' : diff < 0 ? 'var(--down)' : 'var(--muted)'
}

export function fmtDiff(diff: number | null): string {
  if (diff === null) return '—'
  return `${diff >= 0 ? '+' : ''}${diff.toLocaleString()}`
}

export function fmtViews(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${Math.round(v / 1_000)}K`
  return String(v)
}

export function niceScale(dataMin: number, dataMax: number, targetTicks = 4) {
  const minV = Math.min(dataMin, 0)
  const maxV = Math.max(dataMax, 0)
  if (minV === maxV) return { ticks: [0, maxV || 1], niceMin: 0, niceMax: maxV || 1 }
  const range = maxV - minV
  const rawStep = range / (targetTicks - 1)
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const norm = rawStep / mag
  const step = norm <= 1 ? mag : norm <= 2 ? 2 * mag : norm <= 5 ? 5 * mag : 10 * mag
  const niceMin = Math.floor(minV / step) * step
  const niceMax = Math.ceil(maxV / step) * step
  const ticks: number[] = []
  for (let v = niceMin; v <= niceMax + step * 0.01; v += step) ticks.push(Math.round(v * 1e10) / 1e10)
  return { ticks, niceMin, niceMax }
}

export function elapsedDaysLabel(公開日: string): string {
  if (!公開日) return ''
  const diff = Math.floor((Date.now() - new Date(公開日).getTime()) / 86400000)
  if (diff < 0) return ''
  if (diff === 0) return '公開当日'
  return `公開${diff}日`
}

// ---------------------------------------------------------------- キリ番（シンガーのページのカード）

function getNextMilestone(val: number): number {
  const unit = val < 10000 ? 1000 : val < 100000 ? 10000 : 100000
  return Math.floor(val / unit + 1) * unit
}

function estimateDate(latestDate: string, latestVal: number, milestone: number, avgPerDay: number | null): string {
  if (!avgPerDay || avgPerDay <= 0) return '—'
  const days = (milestone - latestVal) / avgPerDay
  const d = new Date(latestDate)
  d.setDate(d.getDate() + Math.ceil(days))
  return d.toISOString().slice(0, 10)
}

/** 次のキリ番に届くまでの日数（並べ替え「キリ番到達順」用）。届かない見込みなら Infinity */
export function viewMilestoneDays(再生数: number, daily: (number | null)[]): number {
  const vals = daily.filter((v): v is number => v !== null)
  if (vals.length === 0) return Infinity
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length
  if (avg <= 0) return Infinity
  const days = (getNextMilestone(再生数) - 再生数) / avg
  return days > 0 ? days : Infinity
}

export function viewMilestoneLabel(再生数: number, daily: (number | null)[]): string | null {
  const vals = daily.filter((v): v is number => v !== null)
  if (vals.length === 0) return null
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length
  if (avg <= 0) return null
  const milestone = getNextMilestone(再生数)
  const today = new Date().toISOString().slice(0, 10)
  const dateStr = estimateDate(today, 再生数, milestone, avg)
  if (dateStr === '—') return null
  const [, m, d] = dateStr.split('-')
  const daysLeft = Math.ceil((new Date(dateStr).getTime() - new Date(today).getTime()) / 86400000)
  return `次のキリ番 ${milestone.toLocaleString()} / ${parseInt(m)}月${parseInt(d)}日頃（${daysLeft}日後）`
}
