import { useEffect, useMemo, useState } from 'react'
import {
  Catalog, Channel, Daily, MIN_DATE, RankRow,
  addDays, buildRanking, loadCatalog, loadChannels, loadDailies, loadRecentDailies, rankingDates, talentFirstDates,
} from '../ledger'
import { diffColor, fmtDiffRate } from '../format'

// グループの分け方（旧サイトのツリーマップと同じ）
const GROUPS: { label: string; members: string[] }[] = [
  { label: 'LIVE UNION', members: ['焔魔るり', 'HACHI', '瀬戸乃とと', '水瀬凪'] },
  { label: 'KMN LABEL', members: ['KMNZ', 'HONK THE HORN'] },
  { label: 'VB+NJ', members: ['VESPERBELL', 'NUROJUNK'] },
  { label: 'Fused', members: ['CULUA', 'CONA', '妃玖', 'Diα'] },
  { label: 'GRAY MYTH', members: ['MEMESIA', 'LEWNE', '羽緒', 'Cil', '深影'] },
  { label: 'その他', members: ['NEUN', 'MEDA', 'IMI', 'XIDEN', 'ヨノ', 'wouca'] },
]

type Metric = { key: 'subs' | 'views' | 'likes' | 'comments'; diff: 'subsDiff' | 'viewsDiff' | 'likesDiff' | 'commentsDiff'; label: string }
const METRICS: Metric[] = [
  { key: 'subs', diff: 'subsDiff', label: '登録者数' },
  { key: 'views', diff: 'viewsDiff', label: '総再生数' },
  { key: 'likes', diff: 'likesDiff', label: '総高評価数' },
  { key: 'comments', diff: 'commentsDiff', label: '総コメント数' },
]

const clampDate = (d: string, lo: string, hi: string) => (d < lo ? lo : d > hi ? hi : d)
const spanDays = (start: string, end: string) =>
  Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1

/** ランキングの表1枚。増えた数の多い順に並べ、いちばん下に合計 */
function RankCard({ metric, rows }: { metric: Metric; rows: RankRow[] }) {
  const sorted = [...rows].sort((a, b) => (b[metric.diff] ?? -Infinity) - (a[metric.diff] ?? -Infinity))
  const total = sorted.reduce((s, r) => s + r[metric.key], 0)
  const totalDiff = sorted.every(r => r[metric.diff] === null) ? null : sorted.reduce((s, r) => s + (r[metric.diff] ?? 0), 0)
  return (
    <section className="rank-card">
      <h2>{metric.label}</h2>
      <table className="rank-table">
        <tbody>
          {sorted.map((r, i) => (
            <tr key={r.talent}>
              <td className="rank-no">{i + 1}</td>
              <td className="rank-name">{r.talent}</td>
              <td className="rank-val">{r.nodata ? '—' : r[metric.key].toLocaleString()}</td>
              <td className="rank-diff" style={{ color: diffColor(r[metric.diff]) }}>{fmtDiffRate(r[metric.diff], r[metric.key])}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="rank-no" />
            <td className="rank-name">合計</td>
            <td className="rank-val">{total.toLocaleString()}</td>
            <td className="rank-diff" style={{ color: diffColor(totalDiff) }}>{fmtDiffRate(totalDiff, total)}</td>
          </tr>
        </tfoot>
      </table>
    </section>
  )
}

/** トップページ。シンガーのランキング4枚（登録者数・総再生数・総高評価数・総コメント数）と、日付・期間の指定、グループでの絞り込み */
export default function Dashboard() {
  const [base, setBase] = useState<{ channels: Channel[]; catalog: Catalog; latest: string } | null>(null)
  const [mode, setMode] = useState<'day' | 'range'>('day')
  const [day, setDay] = useState('')
  const [range, setRange] = useState({ start: '', end: '' })
  const [group, setGroup] = useState('すべて')
  const [snaps, setSnaps] = useState<{ key: string; data: Record<string, Daily> } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)

  // 最新の日と、シンガー・台帳
  useEffect(() => {
    setError(null)
    Promise.all([loadChannels(), loadCatalog(), loadRecentDailies(1)])
      .then(([channels, catalog, [d]]) => {
        if (!d) throw new Error('記録が見つかりません')
        setBase({ channels, catalog, latest: d.date })
        setDay(prev => prev || d.date)
        setRange(prev => (prev.start ? prev : { start: d.date, end: d.date }))
      })
      .catch(e => setError(String(e.message ?? e)))
  }, [retry])

  const start = mode === 'day' ? day : range.start
  const end = mode === 'day' ? day : range.end
  const key = `${start}|${end}`
  const firstDates = useMemo(() => (base ? talentFirstDates(base.catalog) : {}), [base])

  // 選んだ日・期間に要る daily だけを読む
  useEffect(() => {
    if (!base || !start) return
    let alive = true
    setError(null)
    const dates = rankingDates(firstDates, start, end)
    loadDailies(dates)
      .then(data => {
        if (!alive) return
        const missing = dates.filter(d => !data[d])
        if (missing.length) setError(`${missing.join('、')} の記録を取得できませんでした`)
        else setSnaps({ key: `${start}|${end}`, data })
      })
      .catch(e => alive && setError(String(e.message ?? e)))
    return () => { alive = false }
  }, [base, firstDates, start, end, retry])

  const rows = useMemo(() => {
    if (!base || snaps?.key !== key) return null
    const all = buildRanking(base.channels, base.catalog, start, end, snaps.data)
    const members = GROUPS.find(g => g.label === group)?.members
    return members ? all.filter(r => members.includes(r.talent)) : all
  }, [base, snaps, key, start, end, group])

  function changeMode(m: 'day' | 'range') {
    if (m === mode) return
    // 期間に切り替えたら、見ていた日までの1週間から始める。1日に戻したら期間の終わりの日を出す
    if (m === 'range') setRange({ start: clampDate(addDays(day, -6), MIN_DATE, day), end: day })
    else setDay(range.end)
    setMode(m)
  }

  if (!base) {
    return error
      ? <p className="error">データを取得できませんでした: {error}<button className="retry" onClick={() => setRetry(n => n + 1)}>再試行</button></p>
      : <p className="muted loading">読み込み中…</p>
  }

  return (
    <div className="dashboard">
      <div className="dash-controls">
        <div className="seg">
          <button className={mode === 'day' ? 'active' : ''} onClick={() => changeMode('day')}>1日</button>
          <button className={mode === 'range' ? 'active' : ''} onClick={() => changeMode('range')}>期間</button>
        </div>
        {mode === 'day' ? (
          <div className="date-pick">
            <button className="date-step" disabled={day <= MIN_DATE} onClick={() => setDay(addDays(day, -1))} aria-label="前の日">◀</button>
            <input type="date" className="date-input" min={MIN_DATE} max={base.latest} value={day}
              onChange={e => e.target.value && setDay(clampDate(e.target.value, MIN_DATE, base.latest))} />
            <button className="date-step" disabled={day >= base.latest} onClick={() => setDay(addDays(day, 1))} aria-label="次の日">▶</button>
          </div>
        ) : (
          <div className="date-pick">
            <input type="date" className="date-input" min={MIN_DATE} max={range.end} value={range.start}
              onChange={e => e.target.value && setRange({ start: clampDate(e.target.value, MIN_DATE, range.end), end: range.end })} />
            <span className="date-sep">〜</span>
            <input type="date" className="date-input" min={range.start} max={base.latest} value={range.end}
              onChange={e => e.target.value && setRange({ start: range.start, end: clampDate(e.target.value, range.start, base.latest) })} />
          </div>
        )}
        <span className="date-label">
          {mode === 'day' ? `${day}（前日比）` : `${start}〜${end}（${spanDays(start, end)}日間の増加）`}
        </span>
      </div>

      <div className="group-bar">
        {['すべて', ...GROUPS.map(g => g.label)].map(g => (
          <button key={g} className={`chip${group === g ? ' active' : ''}`} onClick={() => setGroup(g)}>{g}</button>
        ))}
      </div>

      {error ? (
        <p className="error">{error}<button className="retry" onClick={() => setRetry(n => n + 1)}>再試行</button></p>
      ) : !rows ? (
        <p className="muted loading">読み込み中…</p>
      ) : (
        <div className="rank-cards">
          {METRICS.map(m => <RankCard key={m.key} metric={m} rows={rows} />)}
        </div>
      )}
      <hr className="dash-rule" />
    </div>
  )
}
