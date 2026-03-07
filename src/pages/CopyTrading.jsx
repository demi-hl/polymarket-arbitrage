import React, { useState, useEffect, useRef, useCallback } from 'react'
import { motion } from 'framer-motion'
import { StaggerContainer, StaggerItem } from '../components/PageTransition'
import { Activity, TrendingUp, TrendingDown, Clock, ExternalLink } from '../components/Icons'

function Skeleton({ className = '' }) {
  return <div className={`shimmer rounded-2xl bg-trader-700/50 ${className}`} />
}

function useWhaleData() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/whales')
        const json = await res.json()
        if (json.success) setData(json.data)
      } catch {} finally { setLoading(false) }
    }
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])
  return { data, loading }
}

function useOrderflowFeed() {
  const [feed, setFeed] = useState([])
  const [stats, setStats] = useState(null)
  useEffect(() => {
    const load = async () => {
      try {
        const [feedRes, statsRes] = await Promise.all([
          fetch('/api/orderflow/feed'),
          fetch('/api/orderflow/stats'),
        ])
        const feedJson = await feedRes.json()
        const statsJson = await statsRes.json()
        if (feedJson.success) setFeed(feedJson.data?.feed || feedJson.data || [])
        if (statsJson.success) setStats(statsJson.data)
      } catch {}
    }
    load()
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [])
  return { feed, stats }
}

function useWhaleSignals() {
  const [signals, setSignals] = useState([])
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/whales/signals')
        const json = await res.json()
        if (json.success) setSignals(json.data?.signals || json.data || [])
      } catch {}
    }
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])
  return signals
}

function useOracleSignals() {
  const [signals, setSignals] = useState({ whales: [], xSentiment: [] })
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/oracle/signals')
        const json = await res.json()
        if (json.success) setSignals(json.data)
      } catch {}
    }
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])
  return signals
}

function useWebSocket() {
  const [liveEvents, setLiveEvents] = useState([])
  const wsRef = useRef(null)

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${window.location.hostname}:${window.location.port || 3088}`)
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'orderflow' }))
    }

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.channel === 'orderflow') {
          setLiveEvents(prev => [{ ...msg, receivedAt: Date.now() }, ...prev].slice(0, 100))
        }
      } catch {}
    }

    ws.onerror = () => {}
    ws.onclose = () => {}

    return () => {
      try { ws.close() } catch {}
    }
  }, [])

  return liveEvents
}

function timeAgo(ts) {
  const diff = Date.now() - ts
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

function truncAddr(addr) {
  if (!addr) return 'Unknown'
  return addr.slice(0, 6) + '...' + addr.slice(-4)
}

function WalletCard({ wallet, rank }) {
  const pnl = parseFloat(wallet.totalPnl || wallet.pnl || 0)
  const winRate = parseFloat(wallet.winRate || 0)
  return (
    <StaggerItem>
      <div className="rounded-xl border p-4 transition-all duration-300 border-white/[0.06] hover:border-white/[0.12]"
        style={{ background: 'rgba(255,255,255,0.02)' }}
      >
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-mono font-bold"
              style={{
                background: rank <= 3 ? 'rgba(168,85,247,0.12)' : 'rgba(255,255,255,0.04)',
                border: `1px solid ${rank <= 3 ? 'rgba(168,85,247,0.2)' : 'rgba(255,255,255,0.06)'}`,
                color: rank <= 3 ? '#a855f7' : '#6b7280',
              }}
            >
              #{rank}
            </div>
            <div>
              <p className="font-mono text-sm text-white">
                {wallet.username || truncAddr(wallet.wallet || wallet.address)}
              </p>
              {wallet.xUsername && (
                <p className="text-xs text-gray-600">@{wallet.xUsername}</p>
              )}
            </div>
          </div>
          <a
            href={`https://polymarket.com/profile/${wallet.wallet || wallet.address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-600 hover:text-gray-400 transition-colors"
          >
            <ExternalLink size={14} />
          </a>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.1em] text-gray-600 mb-1">P&L</p>
            <p className={`font-mono text-sm font-medium truncate ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {pnl >= 0 ? '+' : ''}${Math.abs(pnl) >= 1000 ? `${(pnl / 1000).toFixed(1)}k` : pnl.toFixed(0)}
            </p>
          </div>
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.1em] text-gray-600 mb-1">Win Rate</p>
            <p className="font-mono text-sm text-white truncate">
              {typeof winRate === 'string' ? winRate : `${(winRate * 100).toFixed(0)}%`}
            </p>
          </div>
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.1em] text-gray-600 mb-1">Markets</p>
            <p className="font-mono text-sm text-gray-400 truncate">{wallet.markets || wallet.totalMarkets || '—'}</p>
          </div>
        </div>
      </div>
    </StaggerItem>
  )
}

function SignalRow({ signal }) {
  const isWhaleFlow = signal.type === 'whale-flow'
  const direction = signal.direction || signal.side || 'UNKNOWN'
  const isBullish = direction === 'BUY' || direction === 'BUY_YES' || direction === 'buy'
  const conf = (signal.confidence * 100).toFixed(0)

  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-white/[0.03] last:border-0">
      <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{
          background: isBullish ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
          border: `1px solid ${isBullish ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`,
        }}
      >
        {isBullish ? <TrendingUp size={13} className="text-emerald-400" /> : <TrendingDown size={13} className="text-red-400" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-300 truncate">
          {signal.title || signal.marketId?.slice(0, 16) || 'Unknown Market'}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] uppercase tracking-wider text-gray-600">
            {isWhaleFlow ? 'Flow' : 'Smart $'}
          </span>
          <span className="text-[10px] text-gray-600">
            ${(signal.totalSize || signal.size || 0).toLocaleString()}
          </span>
          <span className="text-[10px] text-gray-600">{conf}% conf</span>
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        <span className={`text-xs font-medium ${isBullish ? 'text-emerald-400' : 'text-red-400'}`}>
          {direction}
        </span>
        <p className="text-[10px] text-gray-600 mt-0.5">{timeAgo(signal.timestamp)}</p>
      </div>
    </div>
  )
}

function FeedEvent({ event }) {
  const isBuy = event.side === 'buy' || event.event === 'whale-trade'
  const isMega = event.event === 'mega-whale' || (event.size && event.size >= 5000)

  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-white/[0.02] last:border-0">
      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isMega ? 'bg-purple-400' : isBuy ? 'bg-emerald-400' : 'bg-red-400'}`}
        style={{ boxShadow: isMega ? '0 0 6px rgba(168,85,247,0.6)' : undefined }}
      />
      <span className="text-xs text-gray-500 font-mono flex-shrink-0 w-14">
        ${(event.size || 0).toLocaleString()}
      </span>
      <span className="text-xs text-gray-400 truncate flex-1">
        {event.assetId?.slice(0, 12) || event.token?.slice(0, 12) || '—'}
      </span>
      <span className={`text-[10px] uppercase ${isBuy ? 'text-emerald-500' : 'text-red-500'}`}>
        {event.side || (isBuy ? 'buy' : 'sell')}
      </span>
      <span className="text-[10px] text-gray-600 flex-shrink-0">
        {timeAgo(event.timestamp || event.receivedAt)}
      </span>
    </div>
  )
}

export default function CopyTrading() {
  const { data: whaleData, loading } = useWhaleData()
  const { feed, stats } = useOrderflowFeed()
  const signals = useWhaleSignals()
  const oracleSignals = useOracleSignals()
  const liveEvents = useWebSocket()
  const [tab, setTab] = useState('wallets')

  const allWhaleSignals = [...(signals || []), ...(oracleSignals.whales || [])]
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 50)

  const combinedFeed = [...(liveEvents || []), ...(feed || [])]
    .sort((a, b) => (b.timestamp || b.receivedAt || 0) - (a.timestamp || a.receivedAt || 0))
    .slice(0, 80)

  const topWallets = whaleData?.topWallets || []
  const consensusSignals = whaleData?.topSignals || []

  if (loading) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-12 w-80" />
        <div className="grid grid-cols-4 gap-5">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
        <div className="grid grid-cols-3 gap-5">
          <Skeleton className="col-span-2 h-[500px]" />
          <Skeleton className="h-[500px]" />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-gradient-minimal">Copy Trading</h2>
          <p className="text-xs text-gray-500 mt-1">
            {whaleData?.trackedWallets || 0} tracked wallets · {allWhaleSignals.length} signals · real-time orderflow
          </p>
        </div>
      </div>

      {/* Stats Row */}
      <StaggerContainer className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StaggerItem>
          <div className="rounded-xl border p-4 border-white/[0.06]" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <p className="text-[10px] uppercase tracking-[0.15em] text-gray-600 mb-1">Tracked Wallets</p>
            <p className="font-mono text-xl text-white">{whaleData?.trackedWallets || 0}</p>
          </div>
        </StaggerItem>
        <StaggerItem>
          <div className="rounded-xl border p-4 border-white/[0.06]" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <p className="text-[10px] uppercase tracking-[0.15em] text-gray-600 mb-1">With Positions</p>
            <p className="font-mono text-xl text-accent">{whaleData?.walletsWithPositions || 0}</p>
          </div>
        </StaggerItem>
        <StaggerItem>
          <div className="rounded-xl border p-4 border-white/[0.06]" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <p className="text-[10px] uppercase tracking-[0.15em] text-gray-600 mb-1">Consensus Signals</p>
            <p className="font-mono text-xl text-purple-400">{whaleData?.consensusSignals || allWhaleSignals.length}</p>
          </div>
        </StaggerItem>
        <StaggerItem>
          <div className="rounded-xl border p-4 border-white/[0.06]" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <p className="text-[10px] uppercase tracking-[0.15em] text-gray-600 mb-1">Orderflow Events</p>
            <p className="font-mono text-xl text-emerald-400">{stats?.totalTrades || combinedFeed.length}</p>
          </div>
        </StaggerItem>
      </StaggerContainer>

      {/* Tab Selector */}
      <div className="flex gap-1 p-1 rounded-lg" style={{ background: 'rgba(255,255,255,0.03)' }}>
        {['wallets', 'signals', 'feed'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
              tab === t
                ? 'text-white bg-white/[0.08]'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {t === 'wallets' ? 'Top Wallets' : t === 'signals' ? 'Whale Signals' : 'Live Feed'}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          {tab === 'wallets' && (
            <StaggerContainer className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {topWallets.length > 0 ? (
                topWallets.map((w, i) => <WalletCard key={w.wallet || w.address || i} wallet={w} rank={i + 1} />)
              ) : (
                <div className="col-span-2 text-center py-16">
                  <p className="text-gray-500 text-sm">No tracked wallets yet</p>
                  <p className="text-gray-600 text-xs mt-1">Whale tracker discovers profitable wallets automatically</p>
                </div>
              )}
            </StaggerContainer>
          )}

          {tab === 'signals' && (
            <div className="rounded-xl border border-white/[0.06] p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <h3 className="text-sm font-medium text-gray-300 mb-3">Whale Consensus Signals</h3>
              {allWhaleSignals.length > 0 ? (
                <div className="space-y-0">
                  {allWhaleSignals.map((s, i) => <SignalRow key={s.timestamp + '-' + i} signal={s} />)}
                </div>
              ) : (
                <div className="text-center py-12">
                  <p className="text-gray-500 text-sm">No whale signals in the last hour</p>
                  <p className="text-gray-600 text-xs mt-1">Signals fire when 3+ whales trade the same direction</p>
                </div>
              )}
            </div>
          )}

          {tab === 'feed' && (
            <div className="rounded-xl border border-white/[0.06] p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-gray-300">Real-Time Orderflow</h3>
                {liveEvents.length > 0 && (
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" style={{ boxShadow: '0 0 6px rgba(16,185,129,0.5)' }} />
                    <span className="text-[10px] text-gray-500 uppercase tracking-wider">Live</span>
                  </div>
                )}
              </div>
              {combinedFeed.length > 0 ? (
                <div className="space-y-0 max-h-[600px] overflow-y-auto">
                  {combinedFeed.map((e, i) => <FeedEvent key={(e.timestamp || e.receivedAt) + '-' + i} event={e} />)}
                </div>
              ) : (
                <div className="text-center py-12">
                  <p className="text-gray-500 text-sm">No orderflow events yet</p>
                  <p className="text-gray-600 text-xs mt-1">Events appear when whale trades ($500+) are detected</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right sidebar — consensus + stats */}
        <div className="space-y-5">
          {/* Active Consensus */}
          <div className="rounded-xl border border-white/[0.06] p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <h3 className="text-sm font-medium text-gray-300 mb-3">Active Consensus</h3>
            {consensusSignals.length > 0 ? (
              <div className="space-y-3">
                {consensusSignals.slice(0, 8).map((sig, i) => (
                  <div key={i} className="py-2 border-b border-white/[0.03] last:border-0">
                    <div className="flex items-center justify-between">
                      <span className={`text-xs font-medium ${sig.outcome === 'YES' ? 'text-emerald-400' : 'text-red-400'}`}>
                        {sig.outcome}
                      </span>
                      <span className="text-[10px] text-gray-600">{sig.confidence}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {sig.whales} whales · ${sig.totalSize}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-600 text-center py-4">No active consensus signals</p>
            )}
          </div>

          {/* Orderflow Stats */}
          {stats && (
            <div className="rounded-xl border border-white/[0.06] p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <h3 className="text-sm font-medium text-gray-300 mb-3">Orderflow Stats</h3>
              <div className="space-y-2.5">
                <div className="flex justify-between">
                  <span className="text-xs text-gray-600">Total Trades</span>
                  <span className="text-xs font-mono text-gray-400">{stats.totalTrades?.toLocaleString() || 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-xs text-gray-600">Whale Trades</span>
                  <span className="text-xs font-mono text-purple-400">{stats.whaleCount || 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-xs text-gray-600">Mega Whales</span>
                  <span className="text-xs font-mono text-purple-300">{stats.megaWhaleCount || 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-xs text-gray-600">Tokens Tracked</span>
                  <span className="text-xs font-mono text-accent">{stats.tokensTracked || 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-xs text-gray-600">Consensus Fires</span>
                  <span className="text-xs font-mono text-emerald-400">{stats.consensusCount || 0}</span>
                </div>
              </div>
            </div>
          )}

          {/* X Sentiment */}
          {oracleSignals.xSentiment?.length > 0 && (
            <div className="rounded-xl border border-white/[0.06] p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <h3 className="text-sm font-medium text-gray-300 mb-3">X Sentiment</h3>
              <div className="space-y-2">
                {oracleSignals.xSentiment.slice(0, 6).map((sig, i) => (
                  <div key={i} className="flex items-center justify-between py-1">
                    <span className="text-xs text-gray-500">{sig.queryId || sig.query}</span>
                    <span className={`text-xs font-medium ${
                      sig.sentiment === 'bullish' ? 'text-emerald-400'
                        : sig.sentiment === 'bearish' ? 'text-red-400'
                        : 'text-gray-500'
                    }`}>
                      {sig.sentiment}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
