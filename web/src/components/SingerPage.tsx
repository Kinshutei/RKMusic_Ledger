import { ReactNode, useEffect, useMemo, useState } from 'react'
import {
  Catalog, Daily, Flags, Stat, VideoCardData, VideoType, VIDEO_TYPES,
  buildSingerHeader, buildVideoCards, loadCatalog, loadFlags, loadRecentDailies,
} from '../ledger'
import { diffColor, fmtDiff, viewMilestoneDays } from '../format'
import VideoCard from './VideoCard'
import Analytics from './Analytics'

// 前日比と15日の増加・キリ番予測に使う日数（15日分の増加を出すには16日分の記録が要る）
const RECENT_DAYS = 16

type SortKey = '再生数' | '高評価数' | 'コメント数' | '再生数15d増加' | '高評価15d増加' | 'キリ番到達日'
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: '再生数', label: '📊 再生数TOP' },
  { key: '高評価数', label: '👍 高評価TOP' },
  { key: 'コメント数', label: '💬 コメント数TOP' },
  { key: '再生数15d増加', label: '📈 再生15日増加' },
  { key: '高評価15d増加', label: '💹 高評価15日増加' },
  { key: 'キリ番到達日', label: '📅 キリ番到達順' },
]
const TAB_LABEL: Record<VideoType, string> = { Movie: '動画', Short: 'ショート', LiveArchive: 'ライブ' }
type Tab = VideoType | 'Analytics'

interface Loaded { catalog: Catalog; flags: Flags; dailies: Daily[] }

function StatItem({ label, s, children }: { label: string; s: Stat; children?: ReactNode }) {
  return (
    <span className="stat">
      {label}：<strong>{s.value.toLocaleString()}</strong>{children}
      {s.diff !== null && <span className="stat-diff" style={{ color: diffColor(s.diff) }}> ({fmtDiff(s.diff)})</span>}
    </span>
  )
}

export default function SingerPage({ name }: { name: string }) {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [tab, setTab] = useState<Tab | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('再生数')
  const [collabOnly, setCollabOnly] = useState(false)

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
  if (!data) return <p className="muted">読み込み中…</p>
  if (!header) return (<><h1 className="singer-name">{name}</h1><p className="muted">まだ記録がありません。</p></>)

  const tabs: Tab[] = [...VIDEO_TYPES.filter(t => byType[t].length > 0), 'Analytics']
  const active: Tab = tab && tabs.includes(tab) ? tab : tabs[0]
  const list = active === 'Analytics' ? [] : byType[active]
  const filtered = collabOnly ? list.filter(v => v.collab_tags.length > 0) : list
  const sorted = [...filtered].sort((a, b) => sortKey === 'キリ番到達日'
    ? viewMilestoneDays(a.再生数, a.再生数daily) - viewMilestoneDays(b.再生数, b.再生数daily)
    : (b[sortKey] as number) - (a[sortKey] as number))

  return (
    <>
      <section className="singer-head">
        <h1 className="singer-name">{name}</h1>
        <div className="singer-stats">
          <StatItem label="登録者数" s={header.登録者数} />
          <StatItem label="総再生数" s={header.総再生数} />
          <StatItem label="総高評価数" s={header.総高評価数} />
          <StatItem label="総コンテンツ数" s={header.総コンテンツ数}>
            <span className="breakdown">（動画 {header.内訳.Movie.toLocaleString()} / ショート {header.内訳.Short.toLocaleString()} / LIVE {header.内訳.LiveArchive.toLocaleString()}）</span>
          </StatItem>
        </div>
      </section>

      <nav className="type-tabs">
        {tabs.map(t => (
          <button key={t} className={`type-tab${active === t ? ' active' : ''}`}
            onClick={() => { setTab(t); setSortKey('再生数'); setCollabOnly(false) }}>
            {t === 'Analytics' ? 'Analytics' : TAB_LABEL[t]}
            {t !== 'Analytics' && <span className="tab-count">({byType[t].length})</span>}
          </button>
        ))}
      </nav>

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
            <button className={`chip${collabOnly ? ' active' : ''}`} onClick={() => setCollabOnly(o => !o)}>🤝 コラボのみ</button>
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
