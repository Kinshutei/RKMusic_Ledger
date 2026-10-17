// ページは URL の # で切り替える（#/ が Dashboard、#/singer/名前 がシンガーのページ）。リンクをそのまま共有できる
export type Route = { page: 'dashboard' } | { page: 'singer'; name: string }

export const singerHref = (name: string) => `#/singer/${encodeURIComponent(name)}`

export function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, '')
  if (h.startsWith('singer/')) return { page: 'singer', name: decodeURIComponent(h.slice('singer/'.length)) }
  return { page: 'dashboard' }
}
