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
