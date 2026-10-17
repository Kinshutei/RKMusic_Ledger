import { VideoCardData } from '../ledger'
import { diffColor, elapsedDaysLabel, fmtDiff, viewMilestoneLabel } from '../format'

function Diff({ v }: { v: number | null }) {
  if (v === null) return null
  return <span className="stat-diff" style={{ color: diffColor(v) }}> ({fmtDiff(v)})</span>
}

/** 動画1本のカード。中身は旧サイトのまま（日別増加のグラフ2つと、その見出しは外した） */
export default function VideoCard({ video }: { video: VideoCardData }) {
  const milestone = viewMilestoneLabel(video.再生数, video.再生数daily)
  return (
    <article className="video-card">
      {video.collab_tags.length > 0 && (
        <div className="collab-tags">
          {video.collab_tags.map(tag => <span key={tag} className="collab-tag">{tag}</span>)}
        </div>
      )}
      <a className="video-title" href={`https://www.youtube.com/watch?v=${video.id}`} target="_blank" rel="noopener noreferrer">
        {video.タイトル}
      </a>
      {video.公開日 && (
        <div className="video-date">{video.公開日} &nbsp;·&nbsp; {elapsedDaysLabel(video.公開日)}</div>
      )}
      <div className="video-stats">
        <span>再生数：<strong>{video.再生数.toLocaleString()}</strong><Diff v={video.再生数daily[0]} /></span>
        <span>高評価：<strong>{video.高評価数.toLocaleString()}</strong><Diff v={video.高評価daily[0]} /></span>
        <span>コメント：<strong>{video.コメント数.toLocaleString()}</strong><Diff v={video.コメント数daily[0]} /></span>
      </div>
      {milestone && <div className="milestone">{milestone}</div>}
    </article>
  )
}
