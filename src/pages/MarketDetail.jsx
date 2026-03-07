import React, { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowLeft, ExternalLink, TrendingUp, TrendingDown, Activity, Clock } from '../components/Icons'
import TAChart from '../components/TAChart'
import { useTrading } from '../context/TradingContext'

const CLOB_API = 'https://clob.polymarket.com'
const GAMMA_API = 'https://gamma-api.polymarket.com'
const INTERVALS = ['1h', '6h', '1d', '1w']

function timeAgo(ts) {
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

function useMarketData(conditionId) {
  const [market, setMarket] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!conditionId) return
    let cancelled = false

    const load = async () => {
      try {
        // Try GAMMA API for market metadata
        const res = await fetch(`${GAMMA_API}/markets?id=${conditionId}&limit=1`, { signal: AbortSignal.timeout(8000) })
        const data = await res.json()
        if (!cancelled && data && data.length > 0) setMarket(data[0])
        else if (!cancelled && data && !Array.isArray(data)) setMarket(data)
      } catch {
        // Try as slug
        try {
          const res2 = await fetch(`${GAMMA_API}/markets?slug=${conditionId}&limit=1`, { signal: AbortSignal.timeout(8000) })
          const data2 = await res2.json()
          if (!cancelled && data2 && data2.length > 0) setMarket(data2[0])
        } catch {}
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [conditionId])

  return { market, loading }
}

function usePriceHistory(tokenId, interval = '1d') {
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!tokenId) return
    let cancelled = false

    const load = async () => {
      setLoading(true)
      try {
        // Polymarket CLOB price history
        const fidelity = interval === '1h' ? 1 : interval === '6h' ? 5 : interval === '1d' ? 60 : 360
        const res = await fetch(
          `${CLOB_API}/prices-history?market=${tokenId}&interval=all&fidelity=${fidelity}`,
          { signal: AbortSignal.timeout(10000) }
        )
        const data = await res.json()
        if (!cancelled && data?.history) {
          const mapped = data.history.map(p => ({
            price: parseFloat(p.p || p.price || 0),
            timestamp: new Date(p.t || p.timestamp || 0).getTime(),
            volume: parseFloat(p.v || p.volume || 0),
          }))
          // Filter by time window
          const now = Date.now()
          const windowMs = interval === '1h' ? 3600000 : interval === '6h' ? 21600000 : interval === '1d' ? 86400000 : 604800000
          const filtered = mapped.filter(p => now - p.timestamp <= windowMs * 30) // Last 30 intervals
          setHistory(filtered.length > 0 ? filtered : mapped.slice(-60))
        }
      } catch {
        // Generate mock data if API fails
        if (!cancelled) {
          const base = 0.5 + Math.random() * 0.3
          const mock = Array.from({ length: 48 }, (_, i) => ({
            price: base + Math.sin(i / 5) * 0.05 + (Math.random() - 0.5) * 0.03,
            timestamp: Date.now() - (48 - i) * 3600000,
            volume: Math.floor(Math.random() * 10000) + 1000,
          }))
          setHistory(mock)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [tokenId, interval])

  return { history, loading }
}

function useOrderbook(tokenId) {
  const [book, setBook] = useState(null)

  useEffect(() => {
    if (!tokenId) return
    let cancelled = false

    const load = async () => {
      try {
        const res = await fetch(`${CLOB_API}/book?token_id=${tokenId}`, { signal: AbortSignal.timeout(6000) })
        const data = await res.json()
        if (!cancelled) setBook(data)
      } catch {}
    }

    load()
    const t = setInterval(load, 10000)
    return () => { cancelled = true; clearInterval(t) }
  }, [tokenId])

  return book
}

function OrderbookViz({ book }) {
  if (!book) return null

  const bids = (book.bids || []).slice(0, 8)
  const asks = (book.asks || []).slice(0, 8)
  const maxSize = Math.max(
    ...bids.map(b => parseFloat(b.size || 0)),
    ...asks.map(a => parseFloat(a.size || 0)),
    1
  )

  return (
    <div className="space-y-3">
      <h4 className="text-xs uppercase tracking-wider text-gray-500 font-medium">Order Book</h4>
      <div className="space-y-0.5">
        {/* Asks (sell orders) - reversed so lowest ask is at bottom */}
        {asks.reverse().map((ask, i) => {
          const size = parseFloat(ask.size || 0)
          const pct = (size / maxSize) * 100
          return (
            <div key={`ask-${i}`} className="flex items-center gap-2 py-1 relative">
              <div className="absolute right-0 top-0 bottom-0 rounded-sm" style={{ width: `${pct}%`, background: 'rgba(239,68,68,0.08)' }} />
              <span className="text-xs font-mono text-red-400 w-16 text-right relative z-10">{(parseFloat(ask.price) * 100).toFixed(1)}%</span>
              <span className="text-xs font-mono text-gray-500 flex-1 text-right relative z-10">${size.toLocaleString()}</span>
            </div>
          )
        })}
        {/* Spread */}
        <div className="py-1 text-center">
          <span className="text-[10px] text-gray-600 font-mono">
            spread: {bids[0] && asks[0] ? ((parseFloat(asks[0]?.price || 0) - parseFloat(bids[0]?.price || 0)) * 100).toFixed(2) + '%' : '—'}
          </span>
        </div>
        {/* Bids (buy orders) */}
        {bids.map((bid, i) => {
          const size = parseFloat(bid.size || 0)
          const pct = (size / maxSize) * 100
          return (
            <div key={`bid-${i}`} className="flex items-center gap-2 py-1 relative">
              <div className="absolute left-0 top-0 bottom-0 rounded-sm" style={{ width: `${pct}%`, background: 'rgba(16,185,129,0.08)' }} />
              <span className="text-xs font-mono text-emerald-400 w-16 text-right relative z-10">{(parseFloat(bid.price) * 100).toFixed(1)}%</span>
              <span className="text-xs font-mono text-gray-500 flex-1 text-right relative z-10">${size.toLocaleString()}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function MarketDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { trades, opportunities } = useTrading()
  const [interval, setInterval] = useState('1d')
  const [showEMA9, setShowEMA9] = useState(true)
  const [showEMA21, setShowEMA21] = useState(true)
  const [showSR, setShowSR] = useState(true)
  const chartRef = useRef(null)
  const [chartWidth, setChartWidth] = useState(800)

  // Decode the ID — could be conditionId, tokenId, or slug
  const decodedId = decodeURIComponent(id)

  const { market, loading: marketLoading } = useMarketData(decodedId)
  const tokenId = market?.clobTokenIds?.[0] || market?.tokens?.[0]?.token_id || decodedId
  const { history, loading: historyLoading } = usePriceHistory(tokenId, interval)
  const orderbook = useOrderbook(tokenId)

  // Responsive chart width
  useEffect(() => {
    const measure = () => {
      if (chartRef.current) {
        setChartWidth(chartRef.current.offsetWidth)
      }
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // Find our trades on this market
  const marketTrades = useMemo(() => {
    return (trades || []).filter(t => {
      const q = (t.question || '').toLowerCase()
      const mq = (market?.question || market?.title || '').toLowerCase()
      return t.conditionId === decodedId
        || t.marketId === decodedId
        || (mq && q && q.includes(mq.slice(0, 30)))
    })
  }, [trades, decodedId, market])

  // Find matching opportunity
  const opp = useMemo(() => {
    return (opportunities || []).find(o =>
      o.conditionId === decodedId || o.marketId === decodedId
    )
  }, [opportunities, decodedId])

  const yesPrice = market?.outcomePrices
    ? parseFloat(JSON.parse(market.outcomePrices)[0] || 0.5)
    : history.length > 0 ? history[history.length - 1].price : 0.5
  const noPrice = 1 - yesPrice
  const volume = parseFloat(market?.volume || market?.volumeNum || 0)
  const liquidity = parseFloat(market?.liquidity || market?.liquidityClob || 0)

  const ease = [0.16, 1, 0.3, 1]
  const anim = (delay = 0) => ({
    initial: { opacity: 0, y: 20, filter: 'blur(6px)' },
    animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
    transition: { delay, duration: 0.6, ease },
  })

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Back nav */}
      <motion.div {...anim(0)} className="flex items-center gap-4">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 text-gray-500 hover:text-white transition-colors group"
        >
          <ArrowLeft size={18} className="group-hover:-translate-x-1 transition-transform" />
          <span className="text-sm">Back</span>
        </button>
      </motion.div>

      {/* Market header */}
      <motion.div {...anim(0.05)}>
        <div className="card p-6">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
            <div className="flex-1">
              <h1 className="text-xl sm:text-2xl font-bold text-white leading-tight mb-3">
                {market?.question || market?.title || decodedId}
              </h1>
              <div className="flex flex-wrap items-center gap-3">
                {market?.slug && (
                  <a
                    href={`https://polymarket.com/event/${market.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs text-accent/70 hover:text-accent transition-colors"
                  >
                    <ExternalLink size={12} />
                    View on Polymarket
                  </a>
                )}
                {market?.endDate && (
                  <span className="flex items-center gap-1.5 text-xs text-gray-500">
                    <Clock size={12} />
                    Resolves {new Date(market.endDate).toLocaleDateString()}
                  </span>
                )}
                {market?.category && (
                  <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-accent/5 text-accent/60 border border-accent/10">
                    {market.category}
                  </span>
                )}
              </div>
            </div>

            {/* Odds display */}
            <div className="flex gap-4">
              <div className="text-center px-5 py-3 rounded-xl" style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.15)' }}>
                <p className="text-[10px] uppercase tracking-wider text-emerald-400/70 mb-1">YES</p>
                <p className="text-2xl font-mono font-bold text-emerald-400">{(yesPrice * 100).toFixed(1)}%</p>
              </div>
              <div className="text-center px-5 py-3 rounded-xl" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)' }}>
                <p className="text-[10px] uppercase tracking-wider text-red-400/70 mb-1">NO</p>
                <p className="text-2xl font-mono font-bold text-red-400">{(noPrice * 100).toFixed(1)}%</p>
              </div>
            </div>
          </div>

          {/* Quick stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5 pt-5" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-gray-600 mb-1">Volume</p>
              <p className="font-mono text-sm text-white">${volume >= 1e6 ? `${(volume / 1e6).toFixed(1)}M` : volume >= 1000 ? `${(volume / 1000).toFixed(1)}K` : volume.toFixed(0)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-gray-600 mb-1">Liquidity</p>
              <p className="font-mono text-sm text-accent">${liquidity >= 1000 ? `${(liquidity / 1000).toFixed(1)}K` : liquidity.toFixed(0)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-gray-600 mb-1">Our Trades</p>
              <p className="font-mono text-sm text-purple-400">{marketTrades.length}</p>
            </div>
            {opp && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-gray-600 mb-1">Edge</p>
                <p className="font-mono text-sm text-profit">+{(opp.edgePercent * 100).toFixed(2)}%</p>
              </div>
            )}
          </div>
        </div>
      </motion.div>

      {/* Chart section */}
      <motion.div {...anim(0.1)}>
        <div className="card p-5" ref={chartRef}>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold text-gray-300">Price Chart</h3>
              {historyLoading && (
                <div className="w-3 h-3 rounded-full border-2 border-accent/30 border-t-accent animate-spin" />
              )}
            </div>

            <div className="flex items-center gap-4">
              {/* Interval selector */}
              <div className="flex gap-1 p-0.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.03)' }}>
                {INTERVALS.map(iv => (
                  <button
                    key={iv}
                    onClick={() => setInterval(iv)}
                    className={`px-2.5 py-1 rounded-md text-[10px] uppercase tracking-wider font-medium transition-all ${
                      interval === iv ? 'text-accent bg-accent/10' : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    {iv}
                  </button>
                ))}
              </div>

              {/* Toggle indicators */}
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setShowEMA9(!showEMA9)}
                  className={`text-[10px] uppercase tracking-wider font-mono px-2 py-0.5 rounded transition-all ${
                    showEMA9 ? 'text-amber-400 bg-amber-400/10' : 'text-gray-600'
                  }`}
                >
                  EMA9
                </button>
                <button
                  onClick={() => setShowEMA21(!showEMA21)}
                  className={`text-[10px] uppercase tracking-wider font-mono px-2 py-0.5 rounded transition-all ${
                    showEMA21 ? 'text-purple-400 bg-purple-400/10' : 'text-gray-600'
                  }`}
                >
                  EMA21
                </button>
                <button
                  onClick={() => setShowSR(!showSR)}
                  className={`text-[10px] uppercase tracking-wider font-mono px-2 py-0.5 rounded transition-all ${
                    showSR ? 'text-accent bg-accent/10' : 'text-gray-600'
                  }`}
                >
                  S/R
                </button>
              </div>
            </div>
          </div>

          <TAChart
            priceHistory={history}
            width={chartWidth - 40}
            height={380}
            showEMA9={showEMA9}
            showEMA21={showEMA21}
            showSR={showSR}
            showVolume={true}
          />
        </div>
      </motion.div>

      {/* Bottom grid — orderbook + trades */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Orderbook */}
        <motion.div {...anim(0.15)} className="card p-5">
          <OrderbookViz book={orderbook} />
          {!orderbook && (
            <div className="text-center py-8">
              <p className="text-gray-600 text-xs">Loading orderbook...</p>
            </div>
          )}
        </motion.div>

        {/* Our trades on this market */}
        <motion.div {...anim(0.2)} className="card p-5 lg:col-span-2">
          <h4 className="text-xs uppercase tracking-wider text-gray-500 font-medium mb-3">
            Our Trades on This Market
            {marketTrades.length > 0 && (
              <span className="ml-2 text-accent">{marketTrades.length}</span>
            )}
          </h4>
          {marketTrades.length > 0 ? (
            <div className="space-y-2 max-h-[300px] overflow-y-auto">
              {marketTrades.map((trade, i) => {
                const pnl = trade.realizedPnl ?? trade.expectedProfit ?? 0
                const isOpen = trade.realizedPnl == null
                return (
                  <div key={trade.id || i}
                    className="flex items-center gap-3 p-3 rounded-lg"
                    style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.03)' }}
                  >
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isOpen ? 'bg-yellow-400' : pnl >= 0 ? 'bg-emerald-400' : 'bg-red-400'}`}
                      style={{ boxShadow: isOpen ? '0 0 6px rgba(250,204,21,0.5)' : pnl >= 0 ? '0 0 6px rgba(16,185,129,0.5)' : '0 0 6px rgba(239,68,68,0.5)' }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-gray-300">{trade.side || 'BUY'} {trade.outcome || 'YES'}</span>
                        <span className="text-[10px] text-accent/50 bg-accent/5 px-1.5 py-0.5 rounded border border-accent/10">{trade.strategy}</span>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-600">
                        <span>@ {((trade.entryPrice || trade.price || 0) * 100).toFixed(1)}%</span>
                        <span>${(trade.positionSize || trade.size || 0).toFixed(0)}</span>
                        {trade.timestamp && <span>{timeAgo(trade.timestamp)}</span>}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <span className={`text-sm font-mono font-semibold ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                      </span>
                      <p className="text-[10px] text-gray-600 mt-0.5">{isOpen ? 'open' : 'closed'}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="text-center py-12">
              <Activity size={24} className="text-gray-700 mx-auto mb-2" />
              <p className="text-gray-600 text-sm">No trades on this market yet</p>
              <p className="text-gray-700 text-xs mt-1">Trades appear when strategies detect and execute on this market</p>
            </div>
          )}
        </motion.div>
      </div>
    </div>
  )
}
