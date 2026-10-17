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

/**
 * RK全体の日ごとの合計（summary/daily_totals.json）。total はその日の全チャンネルの総再生数の合計、
 * inc はその日に増えた再生数（種別ごと。前の日にもある動画の、増えた分だけを足す。最初の日は null）
 */
export interface Totals { dates: string[]; total: number[]; inc: Record<VideoType, (number | null)[]> }
export const loadTotals = () => cached(fileCache, 'totals', () => fetchJson<Totals>('summary/daily_totals.json')) as Promise<Totals | null>

/**
 * シンガーごとの日ごとの合計（summary/talents/{名前}.json）。数え方は RK全体の合計と同じ。
 * total・subs はその日の総再生数・登録者数。記録を始める前の日は null。inc はその日か前の日に記録が無ければ null
 */
export interface TalentTotals { dates: string[]; total: (number | null)[]; subs: (number | null)[]; inc: Record<VideoType, (number | null)[]> }
export const loadTalentTotals = (name: string) => cached(fileCache, `talent:${name}`,
  () => fetchJson<TalentTotals>(`summary/talents/${encodeURIComponent(name)}.json`)) as Promise<TalentTotals | null>

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
  高評価数: number
  コメント数: number
  再生数daily: (number | null)[]   // [0] が最新日の前日比。新しい順に最大15日
  再生数daily_dates: string[]      // 各日の増加の日付（増えた側の日。高評価・コメントも同じ日。値が null の所は無い）
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
      再生数: v, 高評価数: l, コメント数: cm,
      再生数daily: views, 再生数daily_dates: dates, 高評価daily: likes, コメント数daily: comments,
      collab_tags: detectCollabTags(c.タイトル || ''),
    })
  }
  return out
}

// ----------------------------------------------------------------
// Dashboard（シンガーのランキング。旧サイトの「Singer別」と同じ計算）
// ----------------------------------------------------------------

/** 日付・期間の指定で選べる最初の日（3/31 はその前日比の土台） */
export const MIN_DATE = '2026-04-01'

export interface RankRow {
  talent: string
  nodata: boolean            // 選んだ期間がまるごと記録を始める前（途中から加わったシンガー）
  subs: number; subsDiff: number | null
  views: number; viewsDiff: number | null
  likes: number; likesDiff: number | null
  comments: number; commentsDiff: number | null
}

/** シンガーごとの記録を始めた日。台帳の「初記録」のいちばん早い日（途中から加わったシンガーは 4/26 など） */
export function talentFirstDates(catalog: Catalog): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of Object.values(catalog.videos)) {
    if (c.初記録 && (!out[c.タレント] || c.初記録 < out[c.タレント])) out[c.タレント] = c.初記録
  }
  return out
}

/**
 * 期間 start〜end の集計に要る daily の日付。「終わりの日」と「始まりの前日」、
 * それに期間の途中で記録を始めたシンガーの記録開始日。1日だけ見るときは start = end
 */
export function rankingDates(firstDates: Record<string, string>, start: string, end: string): string[] {
  const base = addDays(start, -1)
  const dates = new Set([base, end])
  for (const first of Object.values(firstDates)) if (first > base && first <= end) dates.add(first)
  return [...dates]
}

/**
 * 期間 start〜end に増えた数（1日だけなら前日比）。増えた数は「終わりの日の累計 − 始まりの前日の累計」。
 * - 始まりの前日に記録が無い動画（期間中に公開されたもの）は 0 から数える
 * - 途中から加わったシンガーは記録を始めた日から数え、期間がまるごとその前なら nodata
 * snaps には rankingDates() の日の daily を渡す
 */
export function buildRanking(channels: Channel[], catalog: Catalog, start: string, end: string,
  snaps: Record<string, Daily>): RankRow[] {
  const firstDates = talentFirstDates(catalog)
  const base = addDays(start, -1)
  const endSnap = snaps[end]
  const byTalent = new Map<string, string[]>()
  for (const [id, c] of Object.entries(catalog.videos)) {
    const ids = byTalent.get(c.タレント)
    if (ids) ids.push(id); else byTalent.set(c.タレント, [id])
  }
  return channels.map(({ name }) => {
    const first = firstDates[name]
    const empty: RankRow = { talent: name, nodata: true, subs: 0, subsDiff: null, views: 0, viewsDiff: null,
      likes: 0, likesDiff: null, comments: 0, commentsDiff: null }
    if (!endSnap || !first || first > end) return empty
    const baseSnap = snaps[first > base ? first : base]
    const n = endSnap.channels[name], p = baseSnap?.channels[name]
    let likes = 0, likesDiff = 0, comments = 0, commentsDiff = 0
    for (const id of byTalent.get(name) ?? []) {
      const e = endSnap.v[id]
      if (!e) continue  // 終わりの日にまだ無い（後で公開された）動画・もう外れた動画
      const b = baseSnap?.v[id] ?? [0, 0, 0]
      likes += e[1]; likesDiff += e[1] - b[1]
      comments += e[2]; commentsDiff += e[2] - b[2]
    }
    return {
      talent: name, nodata: false,
      subs: n?.登録者数 ?? 0, subsDiff: n && p ? n.登録者数 - p.登録者数 : null,
      views: n?.総再生数 ?? 0, viewsDiff: n && p ? n.総再生数 - p.総再生数 : null,
      likes, likesDiff: baseSnap ? likesDiff : null,
      comments, commentsDiff: baseSnap ? commentsDiff : null,
    }
  })
}

// ----------------------------------------------------------------
// Analytics（再生数・登録者数の推移と月別の再生数は summary/talents の合計から。ここは投稿ペースと初速カーブ）
// ----------------------------------------------------------------

export type TypeBreakdown = Record<VideoType, number>
export interface MonthEntry extends TypeBreakdown { month: string }
export interface VelocityCurveItem { vid_id: string; title: string; 公開日: string; curve: { day: number; views: number }[] }

const emptyBreakdown = (): TypeBreakdown => ({ Movie: 0, Short: 0, LiveArchive: 0 })

/**
 * 月別の再生数の増加。日ごとの増加（シンガーごとの合計の inc）をその月の分だけ足す。
 * 月の初日に増加の記録が無い月（記録を始めた月）は、月の途中からしか分からないので出さない（旧サイトの2月と同じ扱い）
 */
export function buildMonthlyViews(t: TalentTotals): MonthEntry[] {
  const months = new Map<string, MonthEntry>()
  t.dates.forEach((date, i) => {
    if (t.inc.Movie[i] === null) return
    const month = date.slice(0, 7)
    if (!months.has(month)) {
      if (date.slice(8) !== '01') return
      months.set(month, { month, ...emptyBreakdown() })
    }
    const e = months.get(month)!
    for (const ty of VIDEO_TYPES) e[ty] += t.inc[ty][i] ?? 0
  })
  return [...months.values()]
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
