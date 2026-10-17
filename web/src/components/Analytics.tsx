import { useEffect, useRef, useState } from 'react'
import {
  Catalog, Daily, Flags, MonthEntry, VelocityCurveItem, VideoType, VIDEO_TYPES,
  buildDailyViewsBreakdown, buildMonthlyViews, buildPostingCalendar, buildVelocityCurves,
} from '../ledger'
import { fmtViews, niceScale } from '../format'

const TYPE_COLORS: Record<VideoType, string> = { Movie: 'var(--movie)', Short: 'var(--short)', LiveArchive: 'var(--live)' }
const TYPE_LABELS: Record<VideoType, string> = { Movie: '動画', Short: 'ショート', LiveArchive: 'ライブ' }
const CURVE_COLORS = ['#6677cc', '#cc4455', '#44aa77', '#e89944', '#9944cc', '#44aacc', '#cc9944', '#88aa44', '#cc4499', '#4499cc']

/** 置かれた場所の幅（内側の余白を除く）に合わせてグラフを描き直す */
function useWidth(initial = 600) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(initial)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const s = getComputedStyle(el)
      setW(el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

function Legend() {
  return (
    <div className="legend">
      {VIDEO_TYPES.map(t => (
        <span key={t}><i style={{ backgroundColor: TYPE_COLORS[t] }} />{TYPE_LABELS[t]}</span>
      ))}
    </div>
  )
}

interface BarEntry { key: string; label: string; Movie: number; Short: number; LiveArchive: number }

/**
 * 種別ごとの積み上げ棒グラフ（旧サイトの日別・月別の再生数内訳、投稿ペース）。
 * mode='views' は目盛りを切りのよい数にして合計を上に書く。mode='count' は旧サイトの投稿ペースと同じ目盛り
 */
function StackedBars({ data, mode, empty }: { data: BarEntry[]; mode: 'views' | 'count'; empty: string }) {
  const [ref, containerW] = useWidth()
  if (data.length === 0) return <p className="muted">{empty}</p>
  const maxTotal = Math.max(...data.map(d => d.Movie + d.Short + d.LiveArchive), mode === 'views' ? 1 : 0)
  const PAD = mode === 'views' ? { top: 24, right: 16, bottom: 48, left: 56 } : { top: 16, right: 16, bottom: 48, left: 36 }
  const PLOT_H = mode === 'views' ? 180 : 200
  const BAR_SLOT = Math.max(32, Math.floor((containerW - PAD.left - PAD.right) / data.length))
  const BAR_W = Math.min(28, BAR_SLOT - 4)
  const svgW = Math.max(containerW, PAD.left + PAD.right + data.length * BAR_SLOT)
  const svgH = PAD.top + PLOT_H + PAD.bottom
  const ticks = mode === 'views'
    ? niceScale(0, maxTotal, 5).ticks
    : [0, Math.ceil(maxTotal / 4), Math.ceil(maxTotal / 2), Math.ceil(maxTotal * 3 / 4), maxTotal].filter((v, i, a) => a.indexOf(v) === i)
  const top = mode === 'views' ? maxTotal : Math.max(maxTotal, 1)
  const yScale = PLOT_H / top
  const fmt = mode === 'views' ? fmtViews : String

  return (
    <div ref={ref} className="chart">
      <svg width={svgW} height={svgH}>
        {ticks.map(tick => {
          const y = PAD.top + PLOT_H - tick * yScale
          return (
            <g key={tick}>
              <line x1={PAD.left} y1={y} x2={PAD.left + data.length * BAR_SLOT} y2={y} className={tick === 0 ? 'axis' : 'grid'} />
              <text x={PAD.left - 4} y={y + 4} textAnchor="end" className="tick">{fmt(tick)}</text>
            </g>
          )
        })}
        {data.map((entry, i) => {
          const x = PAD.left + i * BAR_SLOT + (BAR_SLOT - BAR_W) / 2
          let yBase = PAD.top + PLOT_H
          const total = entry.Movie + entry.Short + entry.LiveArchive
          return (
            <g key={entry.key}>
              {VIDEO_TYPES.map(t => {
                const n = entry[t]
                if (n === 0) return null
                const h = n * yScale
                yBase -= h
                return (
                  <rect key={t} x={x} y={yBase} width={BAR_W} height={h} fill={TYPE_COLORS[t]} rx={1}>
                    <title>{entry.key} {TYPE_LABELS[t]}: {mode === 'views' ? n.toLocaleString() : `${n}本`}</title>
                  </rect>
                )
              })}
              {mode === 'views' && total > 0 && (
                <text x={x + BAR_W / 2} y={PAD.top + PLOT_H - total * yScale - 3} textAnchor="middle" className="total">{fmtViews(total)}</text>
              )}
              <text x={x + BAR_W / 2} y={PAD.top + PLOT_H + 14} textAnchor="end" className="tick"
                transform={`rotate(-45, ${x + BAR_W / 2}, ${PAD.top + PLOT_H + 14})`}>{entry.label}</text>
            </g>
          )
        })}
      </svg>
      <Legend />
    </div>
  )
}

function VelocityCurveChart({ items }: { items: VelocityCurveItem[] }) {
  const [ref, containerW] = useWidth()
  if (items.length === 0) return <p className="muted">初速データのある動画がありません（公開日以降のデータが必要です）</p>
  const maxDay = Math.max(...items.flatMap(it => it.curve.map(p => p.day)), 1)
  const maxViews = Math.max(...items.flatMap(it => it.curve.map(p => p.views)), 1)
  const PAD = { top: 16, right: 16, bottom: 36, left: 56 }
  const PLOT_H = 220
  const svgW = containerW
  const PLOT_W = svgW - PAD.left - PAD.right
  const svgH = PAD.top + PLOT_H + PAD.bottom
  const sx = (day: number) => PAD.left + (day / maxDay) * PLOT_W
  const sy = (views: number) => PAD.top + PLOT_H - (views / maxViews) * PLOT_H
  const { ticks } = niceScale(0, maxViews, 5)

  return (
    <div ref={ref} className="chart">
      <svg width={svgW} height={svgH}>
        {ticks.map(tick => (
          <g key={tick}>
            <line x1={PAD.left} y1={sy(tick)} x2={PAD.left + PLOT_W} y2={sy(tick)} className={tick === 0 ? 'axis' : 'grid'} />
            <text x={PAD.left - 4} y={sy(tick) + 4} textAnchor="end" className="tick">{fmtViews(tick)}</text>
          </g>
        ))}
        {[0, 7, 14, 30, 60].filter(d => d <= maxDay).map(d => (
          <g key={d}>
            <line x1={sx(d)} y1={PAD.top} x2={sx(d)} y2={PAD.top + PLOT_H} className="grid" strokeDasharray="3,3" />
            <text x={sx(d)} y={PAD.top + PLOT_H + 14} textAnchor="middle" className="tick">{d}日</text>
          </g>
        ))}
        {items.map((item, idx) => {
          const color = CURVE_COLORS[idx % CURVE_COLORS.length]
          const path = item.curve.map((p, i) => `${i === 0 ? 'M' : 'L'} ${sx(p.day)} ${sy(p.views)}`).join(' ')
          const last = item.curve.at(-1)!
          return (
            <g key={item.vid_id}>
              <path d={path} fill="none" stroke={color} strokeWidth={2} opacity={0.85} />
              <circle cx={sx(last.day)} cy={sy(last.views)} r={3} fill={color} />
            </g>
          )
        })}
      </svg>
      <div className="curve-legend">
        {items.map((item, idx) => (
          <div key={item.vid_id}>
            <i style={{ backgroundColor: CURVE_COLORS[idx % CURVE_COLORS.length] }} />
            <span className="muted">{item.公開日}</span>
            <span>{item.title.length > 30 ? item.title.slice(0, 30) + '…' : item.title}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function YearSelect({ years, value, onChange }: { years: string[]; value: string; onChange: (y: string) => void }) {
  if (years.length <= 1) return null
  return (
    <select className="year-select" value={value} onChange={e => onChange(e.target.value)}>
      {years.map(y => <option key={y} value={y}>{y}年</option>)}
    </select>
  )
}

const toBars = (rows: MonthEntry[]): BarEntry[] => rows.map(r => ({ ...r, key: r.month, label: `${r.month.slice(5)}月` }))
const yearsOf = (rows: MonthEntry[]) => [...new Set(rows.map(r => r.month.slice(0, 4)))].sort()

/** 旧サイトの「分析」。直近15日の内訳・月別の内訳・投稿ペース・初速カーブ */
export default function Analytics({ name, catalog, flags, dailies }: {
  name: string; catalog: Catalog; flags: Flags; dailies: Daily[]
}) {
  const latestDate = dailies.at(-1)!.date
  const daily = buildDailyViewsBreakdown(name, catalog, flags, dailies)
  const posting = buildPostingCalendar(name, catalog, flags)
  const [monthly, setMonthly] = useState<MonthEntry[] | null>(null)
  const [curves, setCurves] = useState<VelocityCurveItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [monthlyYear, setMonthlyYear] = useState('')
  const [postingYear, setPostingYear] = useState(yearsOf(posting).at(-1) ?? '')

  // 月別と初速カーブは、要る日の daily を追加で読む
  useEffect(() => {
    buildMonthlyViews(name, catalog, flags, latestDate)
      .then(rows => { setMonthly(rows); setMonthlyYear(yearsOf(rows).at(-1) ?? '') })
      .catch(e => setError(String(e.message ?? e)))
    buildVelocityCurves(name, catalog, flags, latestDate).then(setCurves).catch(e => setError(String(e.message ?? e)))
  }, [name, catalog, flags, latestDate])

  return (
    <div className="analytics">
      {error && <p className="error">一部のデータを取得できませんでした: {error}</p>}

      <h3>直近15日の再生数内訳（種別×日付）</h3>
      <StackedBars mode="views" empty="再生数データがありません"
        data={daily.map(d => ({ ...d, key: d.date, label: d.date.slice(5) }))} />

      <h3>月別再生数内訳（種別×月）</h3>
      {monthly === null ? <p className="muted">読み込み中…</p> : (
        <>
          <YearSelect years={yearsOf(monthly)} value={monthlyYear} onChange={setMonthlyYear} />
          <StackedBars mode="views" empty="月別再生数データがありません"
            data={toBars(monthlyYear ? monthly.filter(r => r.month.startsWith(monthlyYear)) : monthly)} />
        </>
      )}

      <h3>投稿ペース（種別×月別）</h3>
      <YearSelect years={yearsOf(posting)} value={postingYear} onChange={setPostingYear} />
      <StackedBars mode="count" empty="投稿データがありません"
        data={toBars(postingYear ? posting.filter(r => r.month.startsWith(postingYear)) : posting)} />

      <h3>初速カーブ（直近Movie 最大10本）</h3>
      <p className="note">公開日を0日として、その後の再生数の伸びを比較します。</p>
      {curves === null ? <p className="muted">読み込み中…</p> : <VelocityCurveChart items={curves} />}
    </div>
  )
}
