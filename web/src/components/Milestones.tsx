import { useEffect, useMemo, useState } from 'react'
import {
  MILESTONE_DETAIL_HOURS, MilestoneForecast,
  addDays, buildMilestoneForecast, loadCatalog, loadDailies, loadFlags, loadHourlies, loadRecentDailies, nowHourJst, todayJst,
} from '../ledger'

const TYPES = [{ key: 'Movie', label: '動画' }, { key: 'Short', label: 'ショート' }] as const
const RANGES = [{ days: 0, label: 'すべて' }, { days: 1, label: '1日以内' }, { days: 3, label: '3日以内' }, { days: 7, label: '7日以内' }, { days: 30, label: '1ヶ月以内' }]
const HOUR_MS = 3600_000

/** 日本時間の「月/日」と「時」。時は前後30分で丸める（14:40 → 15時）。year と違う年なら「2027/1/1」のように年も付ける */
function jst(ms: number, year?: number) {
  const d = new Date(Math.round(ms / HOUR_MS) * HOUR_MS + 9 * HOUR_MS)
  const md = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
  return { date: year !== undefined && d.getUTCFullYear() !== year ? `${d.getUTCFullYear()}/${md}` : md, hour: d.getUTCHours() }
}

/** Dashboard のキリ番予測。動画・ショートが次のキリ番に届く時刻を、近い順に並べる */
export default function Milestones() {
  const [type, setType] = useState<'Movie' | 'Short'>('Movie')
  const [range, setRange] = useState(1)
  const [data, setData] = useState<{ list: MilestoneForecast[]; asOf: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 最新の daily とその前の2日、前の日と今日の毎時の記録
  useEffect(() => {
    (async () => {
      const [catalog, flags, [d0]] = await Promise.all([loadCatalog(), loadFlags(), loadRecentDailies(1)])
      if (!d0) throw new Error('記録が見つかりません')
      const y1 = addDays(d0.date, -1), y2 = addDays(d0.date, -2)
      const dailies = await loadDailies([y1, y2])
      if (!dailies[y1]) throw new Error(`${y1} の記録を取得できませんでした`)
      const upTo = d0.date === todayJst() ? nowHourJst() : 23
      const hours = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
      const [yesterday, today] = await Promise.all([loadHourlies(y1, hours(23)), loadHourlies(d0.date, hours(upTo))])
      setData(buildMilestoneForecast(catalog, flags, { d0, d1: dailies[y1], d2: dailies[y2] ?? null, yesterday, today }))
    })().catch(e => setError(String(e.message ?? e)))
  }, [])

  const shown = useMemo(() => (data ? data.list.filter(m => m.type === type && (!range || m.hours <= range * 24)) : []), [data, type, range])

  const head = (
    <div className="panel-head">
      <div className="panel-title">
        <h2>キリ番予測</h2>
        {data && <span className="panel-sub">{jst(data.asOf).date} {jst(data.asOf).hour}時の記録から・{shown.length.toLocaleString()}件</span>}
      </div>
      <div className="panel-tools">
        <div className="seg">
          {TYPES.map(t => <button key={t.key} className={type === t.key ? 'active' : ''} onClick={() => setType(t.key)}>{t.label}</button>)}
        </div>
        <div className="seg wrap">
          {RANGES.map(r => <button key={r.days} className={range === r.days ? 'active' : ''} onClick={() => setRange(r.days)}>{r.label}</button>)}
        </div>
      </div>
    </div>
  )

  if (error) return <section className="panel">{head}<p className="error">予測に要る記録を取得できませんでした: {error}</p></section>
  if (!data) return <section className="panel">{head}<p className="muted loading">読み込み中…</p></section>

  return (
    <section className="panel milestones">
      {head}
      {shown.length === 0 ? <p className="muted">該当する動画はありません</p> : (
        <ol className="ms-list">
          {shown.map(m => {
            const when = jst(m.at, new Date(data.asOf + 9 * HOUR_MS).getUTCFullYear())
            return (
              <li key={m.id} className="ms-row">
                <div className="ms-when">
                  <strong>{when.date}</strong>
                  {m.hours <= MILESTONE_DETAIL_HOURS && <span>{when.hour}時頃</span>}
                </div>
                <div className="ms-body">
                  <a className="ms-title" href={`https://www.youtube.com/watch?v=${m.id}`} target="_blank" rel="noopener noreferrer" title={m.title}>{m.title}</a>
                  <span className="ms-talent">{m.talent}</span>
                </div>
                <div className="ms-nums">
                  <span className="ms-target">{m.milestone.toLocaleString()}</span>
                  <span className="ms-rest">今 {m.value.toLocaleString()}（あと {(m.milestone - m.value).toLocaleString()}）</span>
                </div>
              </li>
            )
          })}
        </ol>
      )}
      <p className="panel-note">
        動画ごとの直近24時間の伸びと、RK全体の時刻ごとの伸び方から予測しています。公開14日以内の動画は、前の日からの落ち方も考えます。
        3日より先は日付だけです。公開から24時間たっていない動画は出しません。
      </p>
    </section>
  )
}
