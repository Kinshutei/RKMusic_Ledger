import { useEffect, useState } from 'react'
import { Channel, loadChannels } from './ledger'
import { Route, parseHash } from './route'
import Header from './components/Header'
import SingerPage from './components/SingerPage'
import Dashboard from './components/Dashboard'
import './styles.css'

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash)
  const [channels, setChannels] = useState<Channel[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onHash = () => { setRoute(parseHash()); window.scrollTo(0, 0) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    loadChannels().then(setChannels).catch(e => setError(String(e.message ?? e)))
  }, [])

  return (
    <>
      <Header route={route} channels={channels} />
      <main className="page">
        {error && <p className="error">シンガーの一覧を取得できませんでした: {error}</p>}
        {route.page === 'dashboard' ? (
          <Dashboard />
        ) : (
          <SingerPage key={route.name} name={route.name} />
        )}
      </main>
    </>
  )
}
