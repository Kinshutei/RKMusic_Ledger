import { useEffect, useRef, useState } from 'react'
import { fmtIncrease, niceScale } from '../format'

/**
 * カードの棒グラフ。1日ごとの再生数の増加を、古い日から順に今日の分まで（最大15日）。
 * 棒の上に増えた数、下に日付（日）。旧サイトのグラフ（今日の分を外していた）と同じ描き方で、今日の分を含める
 */
export default function IncreaseBars({ daily, dates }: { daily: (number | null)[]; dates: string[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(400)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // daily は新しい順。値のある日だけを古い順に並べ直す
  const n = daily.findIndex(v => v === null)
  const count = n === -1 ? daily.length : n
  if (count < 2) return null
  const vals = (daily.slice(0, count) as number[]).reverse()
  const labels = dates.slice(0, count).reverse().map(d => String(parseInt(d.slice(8), 10)))

  const PAD = { top: 18, right: 4, bottom: 18, left: 4 }
  const PLOT_H = 64
  const slot = Math.min(36, Math.floor((width - PAD.left - PAD.right) / count))
  const barW = Math.max(4, Math.min(30, slot - 4))
  const svgW = PAD.left + PAD.right + count * slot
  const svgH = PAD.top + PLOT_H + PAD.bottom
  const { niceMin, niceMax } = niceScale(Math.min(...vals), Math.max(...vals))
  const range = niceMax - niceMin || 1
  const sy = (v: number) => PAD.top + PLOT_H - ((v - niceMin) / range) * PLOT_H
  const zeroY = sy(0)

  return (
    <div ref={ref} className="increase-bars">
      <svg width={svgW} height={svgH}>
        <line x1={PAD.left} y1={zeroY} x2={PAD.left + count * slot} y2={zeroY} className="zero" />
        {vals.map((v, i) => {
          const top = Math.min(sy(v), zeroY)
          const h = Math.max(Math.abs(sy(v) - zeroY), 1)
          const x = PAD.left + slot * i + (slot - barW) / 2
          const cx = x + barW / 2
          return (
            <g key={i}>
              <rect x={x} y={top} width={barW} height={h} rx={2} className={v >= 0 ? 'up' : 'down'}>
                <title>{labels[i]}日: {v >= 0 ? '+' : ''}{v.toLocaleString()}</title>
              </rect>
              <text x={cx} y={v >= 0 ? top - 3 : top + h + 10} textAnchor="middle" className={v >= 0 ? 'value' : 'value down'}>
                {fmtIncrease(v)}
              </text>
              <text x={cx} y={PAD.top + PLOT_H + 14} textAnchor="middle" className="day">{labels[i]}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
