import { ReactNode, useEffect, useMemo, useState } from 'react'
import {
  Catalog, Daily, Flags, Stat, VideoCardData, VideoType, VIDEO_TYPES,
  buildSingerHeader, buildVideoCards, loadCatalog, loadFlags, loadRecentDailies,
} from '../ledger'
import { diffColor, fmtDiff } from '../format'
import VideoCard from './VideoCard'
import Analytics from './Analytics'

// 前日比と、カードの棒グラフ（今日を含む15日分の増加）に使う日数。15日分の増加を出すには16日分の記録が要る
const RECENT_DAYS = 16

type SortKey = '再生数' | '高評価数' | 'コメント数'
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: '再生数', label: '再生数TOP' },
  { key: '高評価数', label: '高評価TOP' },
  { key: 'コメント数', label: 'コメント数TOP' },
]
const TAB_LABEL: Record<VideoType, string> = { Movie: '動画', Short: 'ショート', LiveArchive: 'ライブ' }
type Tab = VideoType | 'Analytics'

/** 検索で比べる形。全角・半角、大文字・小文字の違いをなくす */
const norm = (s: string) => s.normalize('NFKC').toLowerCase()

interface Loaded { catalog: Catalog; flags: Flags; dailies: Daily[] }

/** シンガー名の横の小さなタイル。ラベル・数字・前日比 */
function StatTile({ label, s, children }: { label: string; s: Stat; children?: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{s.value.toLocaleString()}</span>
      {s.diff !== null && <span className="stat-diff" style={{ color: diffColor(s.diff) }}>{fmtDiff(s.diff)}</span>}
      {children}
    </div>
  )
}

export default function SingerPage({ name }: { name: string }) {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [tab, setTab] = useState<Tab | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('再生数')
  const [query, setQuery] = useState('')

  useEffect(() => {
    setError(null)
    Promise.all([loadCatalog(), loadFlags(), loadRecentDailies(RECENT_DAYS)])
      .then(([catalog, flags, dailies]) => setData({ catalog, flags, dailies }))
      .catch(e => setError(String(e.message ?? e)))
  }, [attempt])

  const header = useMemo(() => data && buildSingerHeader(name, data.catalog, data.flags, data.dailies), [data, name])
  const byType = useMemo(() => {
    const out: Record<VideoType, VideoCardData[]> = { Movie: [], Short: [], LiveArchive: [] }
    if (data) for (const v of buildVideoCards(name, data.catalog, data.flags, data.dailies)) out[v.type].push(v)
    return out
  }, [data, name])

  if (error) {
    return (
      <p className="error">データを取得できませんでした: {error}
        <button className="retry" onClick={() => setAttempt(a => a + 1)}>再試行</button></p>
    )
  }
  if (!data) return <p className="muted loading">読み込み中…</p>
  if (!header) return (<><h1 className="singer-name">{name}</h1><p className="muted">まだ記録がありません。</p></>)

  const tabs: Tab[] = [...VIDEO_TYPES.filter(t => byType[t].length > 0), 'Analytics']
  const active: Tab = tab && tabs.includes(tab) ? tab : tabs[0]
  const searching = active !== 'Analytics' && query.trim() !== ''
  const q = norm(query.trim())
  const shown = active === 'Analytics' ? [] : searching ? byType[active].filter(v => norm(v.タイトル).includes(q)) : byType[active]
  const sorted = [...shown].sort((a, b) => b[sortKey] - a[sortKey])

  return (
    <>
      <section className="singer-head">
        <h1 className="singer-name">{name}</h1>
        <div className="singer-stats">
          <StatTile label="登録者数" s={header.登録者数} />
          <StatTile label="総再生数" s={header.総再生数} />
          <StatTile label="総高評価数" s={header.総高評価数} />
          <StatTile label="総コンテンツ数" s={header.総コンテンツ数}>
            <span className="breakdown">動画 {header.内訳.Movie.toLocaleString()} / ショート {header.内訳.Short.toLocaleString()} / LIVE {header.内訳.LiveArchive.toLocaleString()}</span>
          </StatTile>
        </div>
      </section>

      <div className="tab-row">
        <nav className="type-tabs">
          {tabs.map(t => (
            <button key={t} className={`type-tab${active === t ? ' active' : ''}`}
              onClick={() => { setTab(t); setSortKey('再生数') }}>
              <span className="tab-name">{t === 'Analytics' ? 'Analytics' : TAB_LABEL[t]}</span>
              {t !== 'Analytics' && <span className="tab-count">{byType[t].length}</span>}
            </button>
          ))}
        </nav>
        {/* 今開いているタブの中を、コンテンツ名で絞り込む。Analytics を開いているときは使えない */}
        <div className="search-wrap">
          <label className={`search${active === 'Analytics' ? ' disabled' : ''}`}>
            <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden><circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M13 13l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
            <input type="text" inputMode="search" enterKeyHint="search" value={query} disabled={active === 'Analytics'}
              placeholder={active === 'Analytics' ? '動画・ショート・ライブで使えます' : 'タイトルで検索'}
              onChange={e => setQuery(e.target.value)} aria-label="タイトルで検索" />
            {searching && <button type="button" className="search-clear" aria-label="消す" onClick={() => setQuery('')}>×</button>}
          </label>
          {searching && <span className="search-count">{sorted.length.toLocaleString()}件</span>}
        </div>
      </div>

      {active === 'Analytics' ? (
        <Analytics name={name} catalog={data.catalog} flags={data.flags} dailies={data.dailies} />
      ) : (
        <>
          <div className="sort-bar">
            {SORT_OPTIONS.map(o => (
              <button key={o.key} className={`chip${sortKey === o.key ? ' active' : ''}`} onClick={() => setSortKey(o.key)}>
                {o.label}
              </button>
            ))}
          </div>
          <div className="cards">
            {sorted.map(v => <VideoCard key={v.id} video={v} />)}
          </div>
          {sorted.length === 0 && <p className="muted">該当する動画はありません。</p>}
        </>
      )}
    </>
  )
}
