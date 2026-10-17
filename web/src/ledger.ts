// RKMusic_Ledger の記録を GitHub から読み、画面で使う形に集計する。
// 記録の形はリポジトリの README を参照（catalog.json・flags.json・daily/YYYY/YYYY-MM-DD.json）。

export type VideoType = 'Movie' | 'Short' | 'LiveArchive'
export type StoredType = VideoType | 'Pending'
export const VIDEO_TYPES: VideoType[] = ['Movie', 'Short', 'LiveArchive']

export interface Channel { name: string; channel_id: string }

export interface CatalogVideo {
  タレント: string
  タイトル: string
  公開日: string
  duration: number
  type: StoredType
  auto: StoredType
  fixed: boolean
  初記録?: string
  外れた日?: string
}
export interface Catalog {
  channels: Record<string, { チャンネル名: string; banner_url: string; uploads: string }>
  videos: Record<string, CatalogVideo>
}
export type Flags = Record<string, Record<string, VideoType>>

export interface DailyChannel { 登録者数: number; 動画数: number; 総再生数: number; 補完?: boolean }
/** 0時の全件。v は 動画ID → [再生数, 高評価数, コメント数] */
export interface Daily {
  date: string
  at: string | null
  channels: Record<string, DailyChannel>
  v: Record<string, [number, number, number]>
  補完?: string[]
  全体補完?: boolean
}

// 手元で試すときは .env.local で読み先と「今日」を差し替えられる
const BASE = (import.meta.env.VITE_LEDGER_BASE as string | undefined)
  ?? 'https://raw.githubusercontent.com/Kinshutei/RKMusic_Ledger/main'
const TODAY_OVERRIDE = import.meta.env.VITE_LEDGER_TODAY as string | undefined

/**
 * Ledger の最初の daily。これより前の日は取りに行かない。
 * 2026-03-31〜2026-10-17 は旧 RKMusic_AllSinger_PFR から移した記録（3/31 は 4/1 の前日比と4月の月別の土台）
 */
export const LEDGER_START = '2026-03-31'

const FETCH_RETRIES = 3
const FETCH_RETRY_DELAY_MS = 1000
const FETCH_LIMIT = 4  // 同時に取りに行く数。旧サイトでは一度に多く取りに行って 429 で取りこぼした

/** 取れなかったときは例外。404（その日のファイルが無い）は null */
async function fetchJson<T>(path: string): Promise<T | null> {
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(`${BASE}/${path}`)
      if (res.ok) return await res.json() as T
      if (res.status === 404) return null
    } catch {
      // 通信の失敗は取り直す
    }
    if (attempt < FETCH_RETRIES) await new Promise(r => setTimeout(r, FETCH_RETRY_DELAY_MS * (attempt + 1)))
  }
  throw new Error(`${path} を取得できませんでした`)
}

/** 同じものを何度も取りに行かないよう覚えておく。失敗したものは次に取り直せるよう忘れる */
function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let p = cache.get(key)
  if (!p) {
    p = load()
    cache.set(key, p)
    p.catch(() => cache.delete(key))
  }
  return p
}

const fileCache = new Map<string, Promise<unknown>>()
export const loadChannels = () => cached(fileCache, 'channels', () => fetchJson<Channel[]>('channels.json').then(d => d ?? [])) as Promise<Channel[]>
export const loadCatalog = () => cached(fileCache, 'catalog', () => fetchJson<Catalog>('catalog.json')
  .then(d => d ?? { channels: {}, videos: {} })) as Promise<Catalog>
export const loadFlags = () => cached(fileCache, 'flags', () => fetchJson<Flags>('flags.json').then(d => d ?? {})) as Promise<Flags>

const dailyCache = new Map<string, Promise<Daily | null>>()
export const loadDaily = (date: string) =>
  cached(dailyCache, date, () => fetchJson<Daily>(`daily/${date.slice(0, 4)}/${date}.json`))

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }))
  return out
}

/** 指定した日の daily をまとめて取る（無い日は入らない） */
export async function loadDailies(dates: string[]): Promise<Record<string, Daily>> {
  const got = await mapLimit(dates, FETCH_LIMIT, loadDaily)
  const out: Record<string, Daily> = {}
  got.forEach((d, i) => { if (d) out[dates[i]] = d })
  return out
}

/** 'YYYY-MM-DD' を n 日ずらす。端末のタイムゾーンに左右されないよう UTC で計算する */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function todayJst(): string {
  return TODAY_OVERRIDE || new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)
}

function datesBetween(start: string, end: string): string[] {
  const out: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d)
  return out
}

/** 直近 count 日分の daily を古い順に。今日の分がまだ無い時間（0時の収集の前）もあるので少し多めに見に行く */
export async function loadRecentDailies(count: number): Promise<Daily[]> {
  const today = todayJst()
  const from = addDays(today, -(count + 2))
  const dates = datesBetween(from < LEDGER_START ? LEDGER_START : from, today)
  const got = await loadDailies(dates)
  return Object.values(got).sort((a, b) => a.date.localeCompare(b.date)).slice(-count)
}

// ----------------------------------------------------------------
// シンガーのページ
// ----------------------------------------------------------------

/** Pending（配信前・配信中で種別が未確定）など、3種別以外はサイトに出さない */
export function isShownType(t: string): t is VideoType {
  return t === 'Movie' || t === 'Short' || t === 'LiveArchive'
}

const typeOf = (name: string, id: string, c: CatalogVideo, flags: Flags): StoredType => flags[name]?.[id] ?? c.type

const COLLAB_PATTERNS: [RegExp, string][] = [
  [/feat\.?\s+/i, 'feat.'],
  [/ft\.?\s+/i, 'feat.'],
  [/×/, '×コラボ'],
  [/\bw\/\s*/i, 'w/コラボ'],
  [/コラボ/, 'コラボ'],
]
function detectCollabTags(title: string): string[] {
  const tags: string[] = []
  for (const [pattern, label] of COLLAB_PATTERNS) {
    if (pattern.test(title) && !tags.includes(label)) tags.push(label)
  }
  return tags
}

export interface Stat { value: number; diff: number | null }
export interface SingerHeader {
  date: string
  登録者数: Stat
  総再生数: Stat
  総高評価数: Stat
  総コンテンツ数: Stat
  内訳: Record<VideoType, number>
}

export interface VideoCardData {
  id: string
  タイトル: string
  type: VideoType
  公開日: string
  再生数: number
  再生数15d増加: number
  高評価数: number
  高評価15d増加: number
  コメント数: number
  再生数daily: (number | null)[]   // [0] が最新日の前日比。新しい順に最大15日
  再生数daily_dates: string[]      // 再生数daily の各値の日付（増えた側の日。値が null の所は無い）
  高評価daily: (number | null)[]
  コメント数daily: (number | null)[]
  collab_tags: string[]
}

/** そのシンガーの今の動画（一覧から外れた動画は収集をやめているので除く）。カードとシンガー名の横の数字に使う */
function videosOf(name: string, catalog: Catalog): [string, CatalogVideo][] {
  return Object.entries(catalog.videos).filter(([, c]) => c.タレント === name && !c.外れた日)
}

/**
 * そのシンガーの、これまでのすべての動画（一覧から外れた動画も含む）。Analytics の過去を振り返るグラフに使う。
 * 外れた動画は外れた日から daily に記録が無いので、記録のある間だけ数えられる（旧サイトも外れた動画を数えていた）
 */
function everVideosOf(name: string, catalog: Catalog): [string, CatalogVideo][] {
  return Object.entries(catalog.videos).filter(([, c]) => c.タレント === name)
}

/** シンガー名の横の数字。最新の daily と、その前の daily の差を前日比にする */
export function buildSingerHeader(name: string, catalog: Catalog, flags: Flags, dailies: Daily[]): SingerHeader | null {
  const latest = dailies.at(-1)
  if (!latest || !latest.channels[name]) return null
  const prev = dailies.length >= 2 ? dailies.at(-2)! : null
  const ch = latest.channels[name], pch = prev?.channels[name]
  const mine = videosOf(name, catalog)

  const likes = (d: Daily) => mine.reduce((a, [id]) => a + (d.v[id]?.[1] ?? 0), 0)
  const 内訳: Record<VideoType, number> = { Movie: 0, Short: 0, LiveArchive: 0 }
  let prevCount = 0
  for (const [id, c] of mine) {
    const t = typeOf(name, id, c, flags)
    if (!isShownType(t)) continue
    if (latest.v[id]) 内訳[t]++
    if (prev?.v[id]) prevCount++
  }
  const count = 内訳.Movie + 内訳.Short + 内訳.LiveArchive
  return {
    date: latest.date,
    登録者数: { value: ch.登録者数, diff: pch ? ch.登録者数 - pch.登録者数 : null },
    総再生数: { value: ch.総再生数, diff: pch ? ch.総再生数 - pch.総再生数 : null },
    総高評価数: { value: likes(latest), diff: prev ? likes(latest) - likes(prev) : null },
    総コンテンツ数: { value: count, diff: prev ? count - prevCount : null },
    内訳,
  }
}

/**
 * 動画ごとのカード。旧サイト（RKMusic_AllSinger_PFR の buildTalentVideoList）と同じ計算で、
 * 記録のある日を新しい順にたどり、隣の日との差を日別の増加とする（最大15日）。
 */
export function buildVideoCards(name: string, catalog: Catalog, flags: Flags, dailies: Daily[]): VideoCardData[] {
  const latest = dailies.at(-1)
  if (!latest) return []
  const out: VideoCardData[] = []
  for (const [id, c] of videosOf(name, catalog)) {
    const type = typeOf(name, id, c, flags)
    if (!isShownType(type) || !latest.v[id]) continue
    const days = dailies.filter(d => d.v[id])
    const recs = days.map(d => d.v[id])
    const views: (number | null)[] = [], likes: (number | null)[] = [], comments: (number | null)[] = []
    const dates: string[] = []
    for (let i = 1; i <= 15; i++) {
      if (recs.length > i) {
        const curr = recs[recs.length - i], prev = recs[recs.length - i - 1]
        views.push(curr[0] - prev[0])
        likes.push(curr[1] - prev[1])
        comments.push(curr[2] - prev[2])
        dates.push(days[days.length - i].date)
      } else {
        views.push(null); likes.push(null); comments.push(null)
      }
    }
    const [v, l, cm] = latest.v[id]
    out.push({
      id, タイトル: c.タイトル || id, type, 公開日: c.公開日 || '',
      再生数: v, 再生数15d増加: views.reduce<number>((a, x) => a + (x ?? 0), 0),
      高評価数: l, 高評価15d増加: likes.reduce<number>((a, x) => a + (x ?? 0), 0),
      コメント数: cm,
      再生数daily: views, 再生数daily_dates: dates, 高評価daily: likes, コメント数daily: comments,
      collab_tags: detectCollabTags(c.タイトル || ''),
    })
  }
  return out
}

// ----------------------------------------------------------------
// Analytics（旧サイトの「分析」の4つのグラフ）
// ----------------------------------------------------------------

export type TypeBreakdown = Record<VideoType, number>
export interface DailyViewsEntry extends TypeBreakdown { date: string }
export interface MonthEntry extends TypeBreakdown { month: string }
export interface VelocityCurveItem { vid_id: string; title: string; 公開日: string; curve: { day: number; views: number }[] }

const emptyBreakdown = (): TypeBreakdown => ({ Movie: 0, Short: 0, LiveArchive: 0 })

/** 直近の日別の再生数の増加（種別ごと）。増えた分だけを足す */
export function buildDailyViewsBreakdown(name: string, catalog: Catalog, flags: Flags, dailies: Daily[]): DailyViewsEntry[] {
  const mine = everVideosOf(name, catalog)
  const out: DailyViewsEntry[] = []
  for (let i = 1; i < dailies.length; i++) {
    const cur = dailies[i], prev = dailies[i - 1]
    const e: DailyViewsEntry = { date: cur.date, ...emptyBreakdown() }
    for (const [id, c] of mine) {
      const t = typeOf(name, id, c, flags)
      if (!isShownType(t) || !cur.v[id] || !prev.v[id]) continue
      const diff = cur.v[id][0] - prev.v[id][0]
      if (diff > 0) e[t] += diff
    }
    out.push(e)
  }
  return out
}

/** 投稿ペース（公開月ごとの本数） */
export function buildPostingCalendar(name: string, catalog: Catalog, flags: Flags): MonthEntry[] {
  const months = new Map<string, MonthEntry>()
  for (const [id, c] of everVideosOf(name, catalog)) {
    const t = typeOf(name, id, c, flags)
    if (!c.公開日 || !isShownType(t)) continue
    const month = c.公開日.slice(0, 7)
    if (!months.has(month)) months.set(month, { month, ...emptyBreakdown() })
    months.get(month)![t]++
  }
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month))
}

const monthEnd = (month: string) => addDays(`${addMonth(month, 1)}-01`, -1)
function addMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return d.toISOString().slice(0, 7)
}

/**
 * 月別の再生数の増加。その月の最後の日の累計 − 前の月の最後の日の累計（その月に公開された動画は0から）。
 * 前の月の最後の日の記録が無い月（記録を始めた月）は、月の途中からしか分からないので出さない（旧サイトの2月と同じ扱い）。
 */
export async function buildMonthlyViews(name: string, catalog: Catalog, flags: Flags, latestDate: string): Promise<MonthEntry[]> {
  const months: string[] = []
  for (let m = LEDGER_START.slice(0, 7); m <= latestDate.slice(0, 7); m = addMonth(m, 1)) months.push(m)
  const usable = months.filter(m => monthEnd(addMonth(m, -1)) >= LEDGER_START)
  if (!usable.length) return []
  const ends = (m: string) => (monthEnd(m) < latestDate ? monthEnd(m) : latestDate)
  const dates = [...new Set(usable.flatMap(m => [monthEnd(addMonth(m, -1)), ends(m)]))]
  const snaps = await loadDailies(dates)
  // 月の途中で一覧から外れた動画は、月末の記録が無いのでその月は数えない（月末の日だけを読むため）
  const mine = everVideosOf(name, catalog)
  const out: MonthEntry[] = []
  for (const m of usable) {
    const end = snaps[ends(m)], base = snaps[monthEnd(addMonth(m, -1))]
    if (!end || !base) continue
    const e: MonthEntry = { month: m, ...emptyBreakdown() }
    for (const [id, c] of mine) {
      const t = typeOf(name, id, c, flags)
      if (!isShownType(t) || !end.v[id]) continue
      const diff = end.v[id][0] - (base.v[id]?.[0] ?? 0)
      if (diff > 0) e[t] += diff
    }
    out.push(e)
  }
  return out
}

/**
 * 初速カーブ。公開日から60日までの累計再生数を、新しく公開された動画（Movie）から順に、点が2つ以上あるもの最大10本。
 * 動画ごとに、その60日の間の daily だけを読む。
 */
export async function buildVelocityCurves(name: string, catalog: Catalog, flags: Flags, latestDate: string,
  maxVideos = 10, maxDays = 60): Promise<VelocityCurveItem[]> {
  const candidates = everVideosOf(name, catalog)
    .filter(([id, c]) => typeOf(name, id, c, flags) === 'Movie' && c.公開日)
    .sort(([, a], [, b]) => b.公開日.localeCompare(a.公開日))
  const items: VelocityCurveItem[] = []
  for (const [id, c] of candidates) {
    const from = c.公開日 < LEDGER_START ? LEDGER_START : c.公開日
    const last = addDays(c.公開日, maxDays)
    const to = last < latestDate ? last : latestDate
    if (from > to) continue
    const snaps = await loadDailies(datesBetween(from, to))
    const curve: { day: number; views: number }[] = []
    for (const [date, d] of Object.entries(snaps).sort(([a], [b]) => a.localeCompare(b))) {
      if (!d.v[id]) continue
      const day = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${c.公開日}T00:00:00Z`)) / 86400_000)
      curve.push({ day, views: d.v[id][0] })
    }
    if (curve.length >= 2) items.push({ vid_id: id, title: c.タイトル || id, 公開日: c.公開日, curve })
    if (items.length >= maxVideos) break
  }
  return items
}
