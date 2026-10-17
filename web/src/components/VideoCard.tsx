import { VideoCardData } from '../ledger'
import { diffColor, fmtDiff, postedLines, viewMilestoneLabel } from '../format'

function Diff({ v }: { v: number | null }) {
  if (v === null) return null
  return <span className="stat-diff" style={{ color: diffColor(v) }}> ({fmtDiff(v)})</span>
}

/**
 * 動画1本のカード。ヘッダー（左8割にコンテンツ名、右2割に投稿日と経過日数）の下に、再生数・高評価・コメント、
 * その下にキリ番の予測
 */
export default function VideoCard({ video }: { video: VideoCardData }) {
  const milestone = viewMilestoneLabel(video.再生数, video.再生数daily)
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
        <span>再生数：<strong>{video.再生数.toLocaleString()}</strong><Diff v={video.再生数daily[0]} /></span>
        <span>高評価：<strong>{video.高評価数.toLocaleString()}</strong><Diff v={video.高評価daily[0]} /></span>
        <span>コメント：<strong>{video.コメント数.toLocaleString()}</strong><Diff v={video.コメント数daily[0]} /></span>
      </div>
      {milestone && <div className="milestone">{milestone}</div>}
    </article>
  )
}
