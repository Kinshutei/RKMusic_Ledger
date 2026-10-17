import { useEffect, useMemo, useState } from 'react'
import { Totals, VideoType, VIDEO_TYPES, loadTotals } from '../ledger'
import { fmtViews, niceScale } from '../format'

const TYPE_LABEL: Record<VideoType, string> = { Movie: '動画', Short: 'ショート', LiveArchive: 'ライブ' }
const TYPE_COLOR: Record<VideoType, string> = { Movie: 'var(--movie)', Short: 'var(--short)', LiveArchive: 'var(--live)' }
const PERIODS: { days: number; label: string }[] = [{ days: 30, label: '30日' }, { days: 90, label: '90日' }, { days: 0, label: '全期間' }]
const WEEK = ['日', '月', '火', '水', '木', '金', '土']

const md = (d: string) => `${parseInt(d.slice(5, 7), 10)}/${parseInt(d.slice(8), 10)}`
const wd = (d: string) => WEEK[new Date(`${d}T00:00:00Z`).getUTCDay()]

/** 置かれた場所の幅。グラフの枠はデータが届いてから現れるので、現れたときに測り始める */
function useWidth() {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [w, setW] = useState(800)
  useEffect(() => {
    if (!el) return
    const update = () => setW(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, w] as const
}

/** RK全体の、1日に増えた再生数の推移。面グラフに7日平均の線を重ね、上に期間の合計・1日平均・前の期間との比較 */
export default function TrendChart() {
  const [data, setData] = useState<Totals | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState(90)
  const [view, setView] = useState<'total' | 'type'>('total')
  const [hover, setHover] = useState<number | null>(null)
  const [ref, w] = useWidth()

  useEffect(() => {
    loadTotals().then(d => (d ? setData(d) : setError('集計のファイルがまだありません'))).catch(e => setError(String(e.message ?? e)))
  }, [])

  // 1日の増加（合計）と7日平均。最初の日は増加が無い（null）
  const series = useMemo(() => {
    if (!data) return null
    const sum = data.dates.map((_, i) => (data.inc.Movie[i] === null ? null : VIDEO_TYPES.reduce((s, t) => s + (data.inc[t][i] ?? 0), 0)))
    const ma = sum.map((_, i) => {
      const win = sum.slice(Math.max(0, i - 6), i + 1).filter((v): v is number => v !== null)
      return win.length ? win.reduce((a, b) => a + b, 0) / win.length : null
    })
    return { sum, ma }
  }, [data])

  if (error) return <p className="muted">{error}</p>
  if (!data || !series) return <p className="muted loading">読み込み中…</p>

  const first = 1  // 0日目は増加が無い
  const n = data.dates.length
  const from = period ? Math.max(first, n - period) : first
  const idx = Array.from({ length: n - from }, (_, k) => from + k)
  const len = idx.length
  const total = idx.reduce((s, i) => s + (series.sum[i] ?? 0), 0)
  const prevFrom = from - len
  const prevTotal = prevFrom >= first ? Array.from({ length: len }, (_, k) => series.sum[prevFrom + k] ?? 0).reduce((a, b) => a + b, 0) : null
  const change = prevTotal ? (total - prevTotal) / prevTotal * 100 : null

  // 描画
  const H = w < 640 ? 240 : 320
  const PAD = { top: 16, right: 12, bottom: 28, left: 52 }
  const plotW = Math.max(10, w - PAD.left - PAD.right), plotH = H - PAD.top - PAD.bottom
  const maxV = Math.max(...idx.map(i => series.sum[i] ?? 0), 1)
  const { ticks, niceMax } = niceScale(0, maxV, 5)
  const x = (k: number) => PAD.left + (len <= 1 ? 0 : (k / (len - 1)) * plotW)
  const y = (v: number) => PAD.top + plotH - (v / niceMax) * plotH
  const linePath = (vals: (number | null)[]) => vals.map((v, k) => `${k === 0 ? 'M' : 'L'}${x(k).toFixed(1)},${y(v ?? 0).toFixed(1)}`).join('')
  const areaPath = (top: number[], bottom: number[]) =>
    `${top.map((v, k) => `${k === 0 ? 'M' : 'L'}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join('')}` +
    `${bottom.map((_, k) => bottom.length - 1 - k).map(k => `L${x(k).toFixed(1)},${y(bottom[k]).toFixed(1)}`).join('')}Z`

  const sums = idx.map(i => series.sum[i] ?? 0)
  const zeros = sums.map(() => 0)
  // 種別の積み上げ（下から 動画・ショート・ライブ）
  const stacks = (() => {
    let base = zeros
    return VIDEO_TYPES.map(t => {
      const top = idx.map((i, k) => base[k] + (data.inc[t][i] ?? 0))
      const layer = { t, top, bottom: base }
      base = top
      return layer
    })
  })()
  const tickCount = w < 640 ? 4 : 7
  const xTicks = Array.from({ length: tickCount }, (_, j) => Math.round((j / (tickCount - 1)) * (len - 1)))

  function pick(clientX: number, target: SVGSVGElement) {
    const r = target.getBoundingClientRect()
    const k = Math.round(((clientX - r.left - PAD.left) / plotW) * (len - 1))
    setHover(Math.min(len - 1, Math.max(0, k)))
  }
  const hk = hover !== null && hover < len ? hover : null
  const hi = hk !== null ? idx[hk] : null

  return (
    <section className="trend">
      <div className="trend-head">
        <h2>RK全体の再生数</h2>
        <div className="trend-tools">
          <div className="seg">
            {PERIODS.map(p => <button key={p.days} className={period === p.days ? 'active' : ''} onClick={() => { setPeriod(p.days); setHover(null) }}>{p.label}</button>)}
          </div>
          <div className="seg">
            <button className={view === 'total' ? 'active' : ''} onClick={() => setView('total')}>合計</button>
            <button className={view === 'type' ? 'active' : ''} onClick={() => setView('type')}>種別</button>
          </div>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi"><span>期間の増加</span><strong>+{total.toLocaleString()}</strong><small>{md(data.dates[from])}〜{md(data.dates[n - 1])}・{len}日</small></div>
        <div className="kpi"><span>1日平均</span><strong>+{Math.round(total / len).toLocaleString()}</strong></div>
        <div className="kpi"><span>前の{len}日と比べて</span>
          <strong className={change === null ? '' : change >= 0 ? 'up' : 'down'}>{change === null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`}</strong></div>
        <div className="kpi"><span>RK全体の総再生数</span><strong>{data.total[n - 1].toLocaleString()}</strong><small>{md(data.dates[n - 1])} 時点</small></div>
      </div>

      <div ref={ref} className="trend-chart">
        <svg width={w} height={H} onMouseMove={e => pick(e.clientX, e.currentTarget)} onMouseLeave={() => setHover(null)}
          onTouchStart={e => pick(e.touches[0].clientX, e.currentTarget)} onTouchMove={e => pick(e.touches[0].clientX, e.currentTarget)}>
          <defs>
            <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4f46e5" stopOpacity=".42" />
              <stop offset="100%" stopColor="#4f46e5" stopOpacity=".02" />
            </linearGradient>
          </defs>
          {ticks.map(t => (
            <g key={t}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} className="grid" />
              <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" className="tick">{fmtViews(t)}</text>
            </g>
          ))}
          {xTicks.map((k, j) => (
            <text key={k} x={x(k)} y={H - 8} textAnchor={j === 0 ? 'start' : j === xTicks.length - 1 ? 'end' : 'middle'} className="tick">
              {md(data.dates[idx[k]])}
            </text>
          ))}
          {view === 'total' ? (
            <>
              <path d={areaPath(sums, zeros)} fill="url(#trend-fill)" />
              <path d={linePath(sums)} className="daily-line" />
            </>
          ) : stacks.map(s => <path key={s.t} d={areaPath(s.top, s.bottom)} fill={TYPE_COLOR[s.t]} opacity={.85} />)}
          <path d={linePath(idx.map(i => series.ma[i]))} className="ma-line" />
          {hk !== null && hi !== null && (
            <g>
              <line x1={x(hk)} x2={x(hk)} y1={PAD.top} y2={PAD.top + plotH} className="cross" />
              <circle cx={x(hk)} cy={y(series.ma[hi] ?? 0)} r={4} className="ma-dot" />
              {view === 'total' && <circle cx={x(hk)} cy={y(series.sum[hi] ?? 0)} r={4} className="daily-dot" />}
            </g>
          )}
        </svg>
        {hk !== null && hi !== null && (
          <div className={`trend-tip${x(hk) > w * .6 ? ' left' : ''}`} style={{ left: x(hk) }}>
            <div className="tip-date">{md(data.dates[hi])}（{wd(data.dates[hi])}）</div>
            <div className="tip-row"><span>増加</span><strong>+{(series.sum[hi] ?? 0).toLocaleString()}</strong></div>
            <div className="tip-row"><span>7日平均</span><strong>+{Math.round(series.ma[hi] ?? 0).toLocaleString()}</strong></div>
            {view === 'type' && VIDEO_TYPES.map(t => (
              <div key={t} className="tip-row"><span><i style={{ background: TYPE_COLOR[t] }} />{TYPE_LABEL[t]}</span><strong>+{(data.inc[t][hi] ?? 0).toLocaleString()}</strong></div>
            ))}
          </div>
        )}
      </div>

      <div className="legend">
        {view === 'total'
          ? <span><i style={{ background: 'linear-gradient(#4f46e5aa, #4f46e522)' }} />1日の増加</span>
          : VIDEO_TYPES.map(t => <span key={t}><i style={{ background: TYPE_COLOR[t] }} />{TYPE_LABEL[t]}</span>)}
        <span><i className="ma-swatch" />7日平均</span>
      </div>
    </section>
  )
}
