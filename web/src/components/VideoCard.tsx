import { VideoCardData } from '../ledger'
import { diffColor, fmtDiff, postedLines } from '../format'
import IncreaseBars from './IncreaseBars'

function Metric({ label, value, diff }: { label: string; value: number; diff: number | null }) {
  return (
    <span className="metric">
      <span className="metric-label">{label}</span>
      <strong>{value.toLocaleString()}</strong>
      {diff !== null && <span className="stat-diff" style={{ color: diffColor(diff) }}>{fmtDiff(diff)}</span>}
    </span>
  )
}

/**
 * 動画1本のカード。ヘッダー（左8割にコンテンツ名、右2割に投稿日と経過日数）の下に、再生数・高評価・コメント、
 * その下に1日ごとの再生数と高評価の増加の棒グラフ（今日を含む15日。2つ合わせて高さ550px）
 */
export default function VideoCard({ video }: { video: VideoCardData }) {
  const posted = video.公開日 ? postedLines(video.公開日) : null
  return (
    <article className="video-card">
      <div className="card-head">
        <div className="card-title">
          {video.collab_tags.length > 0 && (
            <span className="collab-tags">
              {video.collab_tags.map(tag => <span key={tag} className="collab-tag">{tag}</span>)}
            </span>
          )}
          <a className="video-title" href={`https://www.youtube.com/watch?v=${video.id}`} target="_blank" rel="noopener noreferrer"
            title={video.タイトル}>
            {video.タイトル}
          </a>
        </div>
        <div className="card-date">
          {posted && <><div>{posted.date}</div><div>{posted.elapsed}</div></>}
        </div>
      </div>
      <div className="video-stats">
        <Metric label="再生数" value={video.再生数} diff={video.再生数daily[0]} />
        <Metric label="高評価" value={video.高評価数} diff={video.高評価daily[0]} />
        <Metric label="コメント" value={video.コメント数} diff={video.コメント数daily[0]} />
      </div>
      <div className="card-charts">
        <IncreaseBars label="再生数" kind="views" daily={video.再生数daily} dates={video.再生数daily_dates} />
        <IncreaseBars label="高評価" kind="likes" daily={video.高評価daily} dates={video.再生数daily_dates} />
      </div>
    </article>
  )
}
