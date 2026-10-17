import { useEffect, useId, useMemo, useState } from 'react'
import {
  Catalog, Daily, Flags, MonthEntry, TalentTotals, VelocityCurveItem, VIDEO_TYPES,
  addDays, buildMonthlyViews, buildPostingCalendar, buildVelocityCurves, loadTalentTotals,
} from '../ledger'
import { fmtViews, niceScale } from '../format'
import { PeriodSeg, TrendPanel, TYPE_COLOR, TYPE_LABEL, md, useWidth, wd } from './TrendChart'

const PERIODS = [15, 30, 90, 0]

/** 0 を含めない切りのよい目盛り（登録者数のように大きな値の小さな変化を見る） */
function niceRange(lo: number, hi: number, target = 4) {
  if (lo === hi) {
    // YouTube の登録者数は上3桁で丸められるので、その丸めの単位だけ上下に広げる
    const pad = Math.pow(10, Math.max(0, Math.floor(Math.log10(Math.abs(hi) || 1)) - 2))
    lo -= pad; hi += pad
  }
  const raw = (hi - lo) / target, mag = Math.pow(10, Math.floor(Math.log10(raw))), norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
  const min = Math.floor(lo / step) * step, max = Math.ceil(hi / step) * step
  const ticks: number[] = []
  for (let v = min; v <= max + step / 100; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return { min, max, ticks }
}

const signed = (v: number) => `${v >= 0 ? '+' : ''}${v.toLocaleString()}`

/** 登録者数の推移。丸められた値なので階段状の線で描く。期間は再生数の推移と連動 */
function SubsPanel({ data, period, onPeriod }: { data: TalentTotals; period: number; onPeriod: (d: number) => void }) {
  const [ref, w] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const gradId = `fill${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const n = data.dates.length
  const first = data.subs.findIndex(v => v !== null)
  const start = first < 0 ? n : first
  const from = period ? Math.max(start, n - period) : start
  // 途中で記録が欠けた日は前の日の値のまま
  const vals: number[] = []
  for (let i = from; i < n; i++) vals.push(data.subs[i] ?? vals.at(-1) ?? 0)
  const len = vals.length
  const head = (
    <div className="panel-head">
      <div className="panel-title">
        <h2>登録者数の推移</h2>
        {len >= 2 && <span className="panel-sub">期間で <strong>{signed(vals[len - 1] - vals[0])}</strong>（{md(data.dates[n - 1])} 時点 {vals[len - 1].toLocaleString()}人）</span>}
      </div>
      <div className="panel-tools"><PeriodSeg periods={PERIODS} period={period} onPeriod={p => { onPeriod(p); setHover(null) }} /></div>
    </div>
  )
  if (len < 2) return <section className="panel">{head}<p className="muted">記録がたまると表示されます</p></section>

  const H = w < 640 ? 200 : 240
  const PAD = { top: 12, right: 12, bottom: 28, left: 60 }
  const plotW = Math.max(10, w - PAD.left - PAD.right), plotH = H - PAD.top - PAD.bottom
  const { min, max, ticks } = niceRange(Math.min(...vals), Math.max(...vals))
  const x = (k: number) => PAD.left + (k / (len - 1)) * plotW
  const y = (v: number) => PAD.top + plotH - ((v - min) / (max - min)) * plotH
  // 階段: その日の値を次の日まで保ち、次の日に縦に動く
  const line = vals.map((v, k) => (k === 0 ? `M${x(0).toFixed(1)},${y(v).toFixed(1)}` : `H${x(k).toFixed(1)}V${y(v).toFixed(1)}`)).join('')
  const area = `${line}V${(PAD.top + plotH).toFixed(1)}H${x(0).toFixed(1)}Z`
  const tickCount = Math.min(len, w < 640 ? 4 : 7)
  const xTicks = Array.from({ length: tickCount }, (_, j) => Math.round((j / (tickCount - 1)) * (len - 1)))
  const pick = (clientX: number, el: SVGSVGElement) => {
    const k = Math.round(((clientX - el.getBoundingClientRect().left - PAD.left) / plotW) * (len - 1))
    setHover(Math.min(len - 1, Math.max(0, k)))
  }
  const hk = hover !== null && hover < len ? hover : null

  return (
    <section className="panel subs">
      {head}
      <div ref={ref} className="plot">
        <svg width={w} height={H} onMouseMove={e => pick(e.clientX, e.currentTarget)} onMouseLeave={() => setHover(null)}
          onTouchStart={e => pick(e.touches[0].clientX, e.currentTarget)} onTouchMove={e => pick(e.touches[0].clientX, e.currentTarget)}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4f46e5" stopOpacity=".18" />
              <stop offset="100%" stopColor="#4f46e5" stopOpacity="0" />
            </linearGradient>
          </defs>
          {ticks.map(t => (
            <g key={t}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} className="grid" />
              <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" className="tick">{t.toLocaleString()}</text>
            </g>
          ))}
          {xTicks.map((k, j) => (
            <text key={k} x={x(k)} y={H - 8} textAnchor={j === 0 ? 'start' : j === xTicks.length - 1 ? 'end' : 'middle'} className="tick">
              {md(data.dates[from + k])}
            </text>
          ))}
          <path d={area} fill={`url(#${gradId})`} />
          <path d={line} className="subs-line" />
          {hk !== null && (
            <g>
              <line x1={x(hk)} x2={x(hk)} y1={PAD.top} y2={PAD.top + plotH} className="cross" />
              <circle cx={x(hk)} cy={y(vals[hk])} r={4} className="subs-dot" />
            </g>
          )}
        </svg>
        {hk !== null && (
          <div className={`plot-tip${x(hk) > w * .6 ? ' left' : ''}`} style={{ left: x(hk) }}>
            <div className="tip-date">{md(data.dates[from + hk])}（{wd(data.dates[from + hk])}）</div>
            <div className="tip-row"><span>登録者数</span><strong>{vals[hk].toLocaleString()}</strong></div>
            <div className="tip-row"><span>前日比</span><strong>{from + hk > start ? signed(vals[hk] - (data.subs[from + hk - 1] ?? vals[hk])) : '—'}</strong></div>
          </div>
        )}
      </div>
      <p className="panel-note">YouTube の登録者数は上3桁で丸めて公開されるため、階段状になります。</p>
    </section>
  )
}

/** 月ごとの種別の積み上げ棒。kind='views' は月別の再生数、'count' は投稿ペース（本数）。年を切り替えられる */
function MonthBars({ title, rows, kind, lastDate, fillMonths, note }: {
  title: string; rows: MonthEntry[]; kind: 'views' | 'count'; lastDate: string; fillMonths?: boolean; note?: string
}) {
  const [ref, w] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const years = [...new Set(rows.map(r => r.month.slice(0, 4)))].sort()
  const [year, setYear] = useState(years.at(-1) ?? '')
  const fmt = kind === 'views' ? fmtViews : (v: number) => v.toLocaleString()
  const unit = kind === 'views' ? '' : '本'

  // 投稿ペースは投稿の無い月も 0 本として並べる（今年は今月まで）
  const data = useMemo(() => {
    const picked = rows.filter(r => r.month.startsWith(year))
    if (!fillMonths || !year) return picked
    const last = year === lastDate.slice(0, 4) ? parseInt(lastDate.slice(5, 7), 10) : 12
    return Array.from({ length: last }, (_, i) => {
      const month = `${year}-${String(i + 1).padStart(2, '0')}`
      return picked.find(r => r.month === month) ?? { month, Movie: 0, Short: 0, LiveArchive: 0 }
    })
  }, [rows, year, fillMonths, lastDate])

  const head = (
    <div className="panel-head">
      <h2>{title}</h2>
      {years.length > 1 && (
        <div className="panel-tools">
          <div className="seg years">
            {years.map(yr => <button key={yr} className={year === yr ? 'active' : ''} onClick={() => { setYear(yr); setHover(null) }}>{yr}年</button>)}
          </div>
        </div>
      )}
    </div>
  )
  if (data.length === 0) return <section className="panel">{head}<p className="muted">データがありません</p></section>

  const H = w < 640 ? 220 : 260
  const PAD = { top: 20, right: 8, bottom: 26, left: kind === 'views' ? 52 : 36 }
  const plotW = Math.max(10, w - PAD.left - PAD.right), plotH = H - PAD.top - PAD.bottom
  const totals = data.map(r => VIDEO_TYPES.reduce((s, t) => s + r[t], 0))
  const scale = niceScale(0, Math.max(...totals, 1), 5)
  const ticks = kind === 'count' ? scale.ticks.filter(t => Number.isInteger(t)) : scale.ticks
  const slot = plotW / data.length
  const barW = Math.min(40, slot * .62)
  const base = PAD.top + plotH
  const y = (v: number) => base - (v / scale.niceMax) * plotH
  const GAP = 2
  const showTotals = kind === 'count' || slot >= 30
  // 今月は記録のある日まで（月末の日なら丸ごと）
  const partial = (m: string) => kind === 'views' && m === lastDate.slice(0, 7) && addDays(lastDate, 1).slice(8) !== '01'

  return (
    <section className="panel">
      {head}
      <div ref={ref} className="plot">
        <svg width={w} height={H} onMouseLeave={() => setHover(null)}>
          {ticks.map(t => (
            <g key={t}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis' : 'grid'} />
              <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" className="tick">{fmt(t)}</text>
            </g>
          ))}
          {data.map((r, i) => {
            const cx = PAD.left + slot * (i + .5), x0 = cx - barW / 2
            // 下から 動画・ショート・ライブ。間に2pxのすき間、いちばん上だけ角を丸める
            const segs = VIDEO_TYPES.filter(t => r[t] > 0)
            let acc = 0
            return (
              <g key={r.month}>
                <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={plotH} className={`bar-hit${hover === i ? ' on' : ''}`}
                  onMouseEnter={() => setHover(i)} onTouchStart={() => setHover(i)} />
                {segs.map((t, j) => {
                  const yb = y(acc), yt = y(acc += r[t])
                  const top = j === segs.length - 1
                  const y1 = top ? yt : yt + GAP
                  if (yb - y1 <= 0) return null
                  const rr = top ? Math.min(4, (yb - y1) / 2, barW / 2) : 0
                  const d = `M${x0},${yb}V${y1 + rr}Q${x0},${y1} ${x0 + rr},${y1}H${x0 + barW - rr}Q${x0 + barW},${y1} ${x0 + barW},${y1 + rr}V${yb}Z`
                  return <path key={t} d={d} fill={TYPE_COLOR[t]} opacity={hover === null || hover === i ? 1 : .45} pointerEvents="none" />
                })}
                {showTotals && totals[i] > 0 && <text x={cx} y={y(totals[i]) - 5} textAnchor="middle" className="bar-total" pointerEvents="none">{fmt(totals[i])}</text>}
                <text x={cx} y={H - 8} textAnchor="middle" className="tick" pointerEvents="none">{parseInt(r.month.slice(5), 10)}月</text>
              </g>
            )
          })}
        </svg>
        {hover !== null && hover < data.length && (() => {
          const r = data[hover], cx = PAD.left + slot * (hover + .5)
          return (
            <div className={`plot-tip${cx > w * .6 ? ' left' : ''}`} style={{ left: cx + (cx > w * .6 ? -barW / 2 : barW / 2) }}>
              <div className="tip-date">{r.month.slice(0, 4)}年{parseInt(r.month.slice(5), 10)}月{partial(r.month) ? `（${parseInt(lastDate.slice(8), 10)}日まで）` : ''}</div>
              <div className="tip-row"><span>合計</span><strong>{totals[hover].toLocaleString()}{unit}</strong></div>
              {VIDEO_TYPES.map(t => (
                <div key={t} className="tip-row"><span><i style={{ background: TYPE_COLOR[t] }} />{TYPE_LABEL[t]}</span><strong>{r[t].toLocaleString()}{unit}</strong></div>
              ))}
            </div>
          )
        })()}
      </div>
      <div className="legend">{VIDEO_TYPES.map(t => <span key={t}><i style={{ background: TYPE_COLOR[t] }} />{TYPE_LABEL[t]}</span>)}</div>
      {note && <p className="panel-note">{note}</p>}
    </section>
  )
}

/** 初速カーブ。全部を灰色で描き、一覧の行やカーソルで選んだ1本だけを藍で強調する */
function CurvesPanel({ items }: { items: VelocityCurveItem[] | null }) {
  const [ref, w] = useWidth()
  const [selected, setSelected] = useState(0)
  const [hover, setHover] = useState<{ i: number; p: number } | null>(null)
  const head = <div className="panel-head"><h2>初速カーブ</h2><span className="panel-sub">直近の動画 最大10本・公開日から60日</span></div>
  if (items === null) return <section className="panel">{head}<p className="muted loading">読み込み中…</p></section>
  if (items.length === 0) return <section className="panel">{head}<p className="muted">初速データのある動画がありません（公開日以降のデータが必要です）</p></section>

  const H = w < 640 ? 240 : 300
  const PAD = { top: 12, right: 12, bottom: 28, left: 52 }
  const plotW = Math.max(10, w - PAD.left - PAD.right), plotH = H - PAD.top - PAD.bottom
  const maxDay = Math.max(...items.flatMap(it => it.curve.map(p => p.day)), 1)
  const { ticks, niceMax } = niceScale(0, Math.max(...items.flatMap(it => it.curve.map(p => p.views)), 1), 5)
  const x = (day: number) => PAD.left + (day / maxDay) * plotW
  const y = (v: number) => PAD.top + plotH - (v / niceMax) * plotH
  const path = (it: VelocityCurveItem) => it.curve.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.day).toFixed(1)},${y(p.views).toFixed(1)}`).join('')
  const active = hover?.i ?? (selected < items.length ? selected : 0)
  // カーソルにいちばん近い点の動画を選ぶ
  const pick = (clientX: number, clientY: number, el: SVGSVGElement) => {
    const r = el.getBoundingClientRect(), mx = clientX - r.left, my = clientY - r.top
    let best: { i: number; p: number } | null = null, bestD = Infinity
    items.forEach((it, i) => it.curve.forEach((pt, p) => {
      const d = (x(pt.day) - mx) ** 2 + (y(pt.views) - my) ** 2
      if (d < bestD) { bestD = d; best = { i, p } }
    }))
    setHover(best)
  }
  const hp = hover ? items[hover.i].curve[hover.p] : null

  return (
    <section className="panel">
      {head}
      <div ref={ref} className="plot">
        <svg width={w} height={H} onMouseMove={e => pick(e.clientX, e.clientY, e.currentTarget)} onMouseLeave={() => setHover(null)}
          onTouchStart={e => pick(e.touches[0].clientX, e.touches[0].clientY, e.currentTarget)}>
          {ticks.map(t => (
            <g key={t}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} className="grid" />
              <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" className="tick">{fmtViews(t)}</text>
            </g>
          ))}
          {[0, 7, 14, 30, 60].filter(d => d <= maxDay).map(d => (
            <g key={d}>
              <line x1={x(d)} x2={x(d)} y1={PAD.top} y2={PAD.top + plotH} className="day-line" />
              <text x={x(d)} y={H - 8} textAnchor={d === 0 ? 'start' : x(d) > w - 20 ? 'end' : 'middle'} className="tick">{d}日</text>
            </g>
          ))}
          {items.map((it, i) => i !== active && <path key={it.vid_id} d={path(it)} className="curve" />)}
          <path d={path(items[active])} className="curve on" />
          {(() => { const last = items[active].curve.at(-1)!; return <circle cx={x(last.day)} cy={y(last.views)} r={4} className="curve-dot" /> })()}
          {hp && <circle cx={x(hp.day)} cy={y(hp.views)} r={5} className="curve-dot" />}
        </svg>
        {hover && hp && (
          <div className={`plot-tip${x(hp.day) > w * .6 ? ' left' : ''}`} style={{ left: x(hp.day), top: Math.max(8, Math.min(y(hp.views) - 30, H - 90)) }}>
            <div className="tip-title">{items[hover.i].title}</div>
            <div className="tip-row"><span>公開日</span><strong>{items[hover.i].公開日.replace(/-/g, '/')}</strong></div>
            <div className="tip-row"><span>{hp.day}日目</span><strong>{hp.views.toLocaleString()}</strong></div>
          </div>
        )}
      </div>
      <ul className="curve-list">
        {items.map((it, i) => {
          const last = it.curve.at(-1)!
          return (
            <li key={it.vid_id}>
              <button className={i === active ? 'on' : ''} onClick={() => setSelected(i)} title={it.title}>
                <i /><span className="curve-date">{it.公開日.replace(/-/g, '/')}</span>
                <span className="curve-title">{it.title}</span>
                <span className="curve-views">{last.day}日目 {fmtViews(last.views)}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * シンガーの Analytics。再生数の推移（Dashboard と同じ形）・登録者数の推移・月別の再生数・投稿ペース・初速カーブ。
 * 推移と月別はシンガーごとの合計（summary/talents/{名前}.json）、投稿ペースは台帳、初速カーブは要る日の daily から
 */
export default function Analytics({ name, catalog, flags, dailies }: {
  name: string; catalog: Catalog; flags: Flags; dailies: Daily[]
}) {
  const latestDate = dailies.at(-1)!.date
  const posting = useMemo(() => buildPostingCalendar(name, catalog, flags), [name, catalog, flags])
  const [totals, setTotals] = useState<TalentTotals | null>(null)
  const [curves, setCurves] = useState<VelocityCurveItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState(30)

  useEffect(() => {
    loadTalentTotals(name)
      .then(d => (d ? setTotals(d) : setError('シンガーごとの合計のファイルがまだありません')))
      .catch(e => setError(String(e.message ?? e)))
    buildVelocityCurves(name, catalog, flags, latestDate).then(setCurves).catch(e => setError(String(e.message ?? e)))
  }, [name, catalog, flags, latestDate])
  const monthly = useMemo(() => (totals ? buildMonthlyViews(totals) : []), [totals])

  return (
    <div className="analytics">
      {error && <p className="error">一部のデータを取得できませんでした: {error}</p>}
      {totals ? (
        <>
          <TrendPanel title="再生数の推移" totalLabel="総再生数" data={totals} periods={PERIODS} period={period} onPeriod={setPeriod} />
          <SubsPanel data={totals} period={period} onPeriod={setPeriod} />
          <MonthBars title="月別の再生数" rows={monthly} kind="views" lastDate={latestDate}
            note="その月に増えた再生数です。公開されたその日の分（公開から最初の記録まで）は含みません。" />
        </>
      ) : !error && <p className="muted loading">読み込み中…</p>}
      <MonthBars title="投稿ペース" rows={posting} kind="count" lastDate={latestDate} fillMonths />
      <CurvesPanel items={curves} />
    </div>
  )
}
