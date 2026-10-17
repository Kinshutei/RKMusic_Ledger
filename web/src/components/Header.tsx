import { useEffect, useRef, useState } from 'react'
import { Channel } from '../ledger'
import { Route, singerHref } from '../route'

/** タイトル・Dashboard・シンガー選択（押すと一覧が開く） */
export default function Header({ route, channels }: { route: Route; channels: Channel[] }) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const current = route.page === 'singer' ? route.name : null

  // 一覧の外を押したとき・Esc・ページを移ったときに閉じる
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  useEffect(() => setOpen(false), [route])

  return (
    <header className="app-header">
      <div className="header-inner">
        <a className="brand" href="#/"><span className="brand-mark" aria-hidden />RKMusic Ledger</a>
        <a className={`nav-link${route.page === 'dashboard' ? ' active' : ''}`} href="#/">Dashboard</a>
        <div className="singer-select" ref={boxRef}>
          <button className={`singer-btn${current ? ' active' : ''}${open ? ' open' : ''}`}
            onClick={() => setOpen(o => !o)} aria-expanded={open}>
            <span>{current ?? 'Singer'}</span>
            <span className="caret" aria-hidden>▾</span>
          </button>
          <div className={`singer-panel${open ? ' open' : ''}`} role="menu">
            {channels.map(c => (
              <a key={c.name} href={singerHref(c.name)} role="menuitem"
                className={c.name === current ? 'current' : ''}>{c.name}</a>
            ))}
          </div>
        </div>
      </div>
    </header>
  )
}
