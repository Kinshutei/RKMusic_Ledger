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

/** カードの棒グラフの上の数字。1,000以上は K、100万以上は M で略し、増えた数には + を付ける（+850 / +1K / +2.3M） */
export function fmtIncrease(v: number): string {
  const a = Math.abs(v)
  const body = a >= 999_500 ? `${(a / 1_000_000).toFixed(1)}M` : a >= 1_000 ? `${Math.round(a / 1_000)}K` : String(a)
  return (v > 0 ? '+' : v < 0 ? '-' : '') + body
}

export interface Trend {
  dir: 'up' | 'down' | 'flat'
  days: number     // 比べた日数（直近 days 日と、その前の days 日）
  recent: number   // 直近の平均
  prev: number     // その前の平均
}

/**
 * 1日の伸びの勢い（トレンド）。直近7日の増加の平均と、その前の7日の平均を比べる。
 * 差がその前の平均の ±10% 以内なら横ばい（両方0も横ばい）。記録が14日分に満たないときは、ある日数を半分ずつに分けて比べ、
 * 2日分未満なら出さない。daily は新しい順（[0] が今日の分）
 */
export function trendOf(daily: (number | null)[]): Trend | null {
  const n = daily.findIndex(v => v === null)
  const vals = (n === -1 ? daily : daily.slice(0, n)) as number[]
  const days = Math.min(7, Math.floor(vals.length / 2))
  if (days < 1) return null
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const recent = avg(vals.slice(0, days)), prev = avg(vals.slice(days, days * 2))
  const diff = recent - prev
  const dir = Math.abs(diff) <= Math.abs(prev) * 0.1 ? 'flat' : diff > 0 ? 'up' : 'down'
  return { dir, days, recent, prev }
}

/** 矢印に添える説明。「直近7日 平均52 / その前の7日 平均41（+27%）」 */
export function trendNote(t: Trend): string {
  const f = (v: number) => (Math.abs(v) < 10 ? v.toFixed(1) : Math.round(v).toLocaleString())
  const pct = t.prev !== 0 ? `${t.recent >= t.prev ? '+' : ''}${Math.round((t.recent - t.prev) / Math.abs(t.prev) * 100)}%` : '—'
  return `直近${t.days}日 平均${f(t.recent)} / その前の${t.days}日 平均${f(t.prev)}（${pct}）`
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

/**
 * カードの右上の2行。「投稿日：2025/3/13」と「583日経過」（公開当日は0日経過）。公開日は YYYY-MM-DD（世界標準時の日付）。
 * 日本時間の0時〜9時は、世界標準時ではまだ前の日なので、公開日が今日より先に見えることがある。そのときも0日経過とする
 */
export function postedLines(公開日: string): { date: string; elapsed: string } {
  const [y, m, d] = 公開日.split('-').map(Number)
  const diff = Math.max(0, Math.floor((Date.now() - new Date(公開日).getTime()) / 86400000))
  return { date: `投稿日：${y}/${m}/${d}`, elapsed: `${diff}日経過` }
}
