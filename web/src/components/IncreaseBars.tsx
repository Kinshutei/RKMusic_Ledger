import { useEffect, useRef, useState } from 'react'
import { fmtIncrease, niceScale } from '../format'

/** 置かれた枠の大きさ（幅と高さ）に合わせて描き直す */
function useSize() {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 400, h: 200 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}

/**
 * カードの棒グラフ。1日ごとの増加を、古い日から順に今日の分まで（最大15日）。
 * 棒の上に増えた数（1,000以上は K、100万以上は M）、下に日。枠の高さいっぱいに描く
 */
export default function IncreaseBars({ label, kind, daily, dates }: {
  label: string
  kind: 'views' | 'likes'
  daily: (number | null)[]
  dates: string[]
}) {
  const [ref, { w, h }] = useSize()
  // daily は新しい順。値のある日だけを古い順に並べ直す
  const n = daily.findIndex(v => v === null)
  const count = n === -1 ? daily.length : n
  const vals = (daily.slice(0, count) as number[]).reverse()
  const days = dates.slice(0, count).reverse().map(d => String(parseInt(d.slice(8), 10)))

  // 減った日があるときは、棒の下に書く数字のぶん、日付を下げる
  const hasNeg = vals.some(v => v < 0)
  const PAD = { top: 18, right: 2, bottom: hasNeg ? 32 : 20, left: 2 }
  const plotH = Math.max(40, h - PAD.top - PAD.bottom)
  const slot = count ? Math.min(40, Math.floor((w - PAD.left - PAD.right) / count)) : 0
  const barW = Math.max(4, Math.min(28, slot - 6))
  const { niceMin, niceMax } = niceScale(Math.min(0, ...vals), Math.max(0, ...vals))
  const range = niceMax - niceMin || 1
  const sy = (v: number) => PAD.top + plotH - ((v - niceMin) / range) * plotH
  const zeroY = sy(0)

  return (
    <div className={`increase ${kind}`}>
      <div className="increase-label"><i />{label}</div>
      <div ref={ref} className="increase-bars">
        {count < 2 ? <p className="increase-empty">記録がたまると表示されます</p> : (
          <svg width={PAD.left + PAD.right + count * slot} height={PAD.top + plotH + PAD.bottom}>
            <line x1={PAD.left} y1={zeroY} x2={PAD.left + count * slot} y2={zeroY} className="zero" />
            {vals.map((v, i) => {
              const top = Math.min(sy(v), zeroY)
              const bh = Math.max(Math.abs(sy(v) - zeroY), 1)
              const x = PAD.left + slot * i + (slot - barW) / 2
              const cx = x + barW / 2
              return (
                <g key={i}>
                  <rect x={x} y={top} width={barW} height={bh} rx={3} className={v >= 0 ? 'up' : 'down'}>
                    <title>{days[i]}日: {v >= 0 ? '+' : ''}{v.toLocaleString()}</title>
                  </rect>
                  <text x={cx} y={v >= 0 ? top - 4 : top + bh + 11} textAnchor="middle" className={v >= 0 ? 'value' : 'value neg'}>
                    {fmtIncrease(v)}
                  </text>
                  <text x={cx} y={PAD.top + plotH + PAD.bottom - 5} textAnchor="middle" className="day">{days[i]}</text>
                </g>
              )
            })}
          </svg>
        )}
      </div>
    </div>
  )
}
