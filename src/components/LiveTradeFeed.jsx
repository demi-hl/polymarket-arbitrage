import React, { useRef, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

function isRustTrade(trade) {
  return trade?.fillMethod === 'rust-engine'
    || trade?.executedBy === 'rust-engine'
    || trade?.strategy === 'crypto-latency-arb'
    || Boolean(trade?.rustTradeId)
}

export default function LiveTradeFeed({ trades = [], maxItems = 25 }) {
  const containerRef = useRef(null)
  const [prevCount, setPrevCount] = useState(trades.length)
  const [tradeFilter, setTradeFilter] = useState('all')
  const newCount = Math.max(0, trades.length - prevCount)
  const filteredTrades = trades.filter(trade => {
    if (tradeFilter === 'rust') return isRustTrade(trade)
    if (tradeFilter === 'node') return !isRustTrade(trade)
    return true
  })

  useEffect(() => {
    if (containerRef.current && trades.length > prevCount) containerRef.current.scrollTop = 0
    const t = setTimeout(() => setPrevCount(trades.length), 1500)
    return () => clearTimeout(t)
  }, [trades.length, prevCount])

  return (
    <div className="h-full flex flex-col card" style={{ padding: '20px 20px' }}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <div
              className="w-2 h-2 rounded-full"
              style={{
                background: trades.length > 0 ? '#10b981' : '#6b7280',
                boxShadow: trades.length > 0 ? '0 0 8px rgba(16,185,129,0.5)' : 'none',
              }}
            />
            {trades.length > 0 && (
              <div className="absolute inset-[-3px] rounded-full border border-profit/30 animate-ping" style={{ animationDuration: '2s' }} />
            )}
          </div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-gray-400 font-medium">Live feed</p>
        </div>
        <div className="flex items-center gap-2">
          {[
            { id: 'all', label: 'All' },
            { id: 'rust', label: 'Rust' },
            { id: 'node', label: 'Node' },
          ].map(opt => (
            <button
              key={opt.id}
              type="button"
              aria-pressed={tradeFilter === opt.id}
              onClick={() => setTradeFilter(opt.id)}
              className="relative px-2.5 py-1 rounded-md text-[10px] uppercase tracking-wider font-medium transition-colors cursor-pointer"
              style={{ color: tradeFilter === opt.id ? '#fff' : 'rgba(156,163,175,0.85)' }}
            >
              {tradeFilter === opt.id && (
                <motion.span
                  layoutId="live-feed-trade-toggle"
                  className="absolute inset-0 rounded-md border"
                  style={{ background: 'rgba(0,212,255,0.15)', borderColor: 'rgba(0,212,255,0.35)' }}
                  transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                />
              )}
              <span className="relative z-10">{opt.label}</span>
            </button>
          ))}
        </div>
        {newCount > 0 && (
          <motion.span
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="text-[10px] font-mono text-profit badge-success"
          >
            +{newCount} new
          </motion.span>
        )}
      </div>

      {filteredTrades.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-10">
          <motion.div
            animate={{ opacity: [0.3, 0.6, 0.3] }}
            transition={{ repeat: Infinity, duration: 3 }}
            className="text-center"
          >
            <div className="w-10 h-10 rounded-xl border border-white/[0.06] flex items-center justify-center mb-3 mx-auto"
              style={{ background: 'rgba(255,255,255,0.02)' }}
            >
              <div className="w-4 h-4 rounded-md border border-white/[0.08]"
                style={{ background: 'rgba(0,212,255,0.05)' }}
              />
            </div>
            <p className="text-xs text-gray-500">
              {trades.length === 0 ? 'Waiting for paper trades' : `No ${tradeFilter} trades right now`}
            </p>
            <p className="text-[10px] text-gray-600 mt-1">Bot scans every 90s</p>
          </motion.div>
        </div>
      ) : (
        <div ref={containerRef} className="flex-1 overflow-y-auto -mx-1" style={{ maxHeight: '320px' }}>
          <AnimatePresence>
            {filteredTrades.slice(0, maxItems).map((trade, i) => (
              <TradeRow key={trade.id || `${trade.timestamp}-${i}`} trade={trade} isNew={i < newCount} index={i} />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  )
}

function TradeRow({ trade, isNew, index }) {
  const isA = trade.accountId === 'A'
  const hasRealized = trade.realizedPnl != null
  const profit = hasRealized ? trade.realizedPnl : (trade.expectedProfit || 0)
  const edge = trade.edgePercent ? (trade.edgePercent * 100).toFixed(1) : '0.0'
  const time = trade.timestamp ? new Date(trade.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''
  const color = isA ? '#f59e0b' : '#00d4ff'
  const isClosed = hasRealized || trade.status === 'closed'

  return (
    <motion.div
      initial={isNew ? { opacity: 0, x: -10, filter: 'blur(4px)' } : false}
      animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
      transition={{ delay: isNew ? index * 0.05 : 0, duration: 0.4 }}
      className={`py-3 px-2 rounded-lg transition-all duration-300 ${isNew ? 'trade-flash' : ''}`}
      style={{ borderBottom: '1px solid rgba(255,255,255,0.025)' }}
    >
      <div className="flex items-start gap-3">
        <span
          className="text-[10px] font-bold w-5 flex-shrink-0 text-center py-0.5 rounded"
          style={{ color, background: `${color}10`, border: `1px solid ${color}15` }}
        >
          {trade.accountId || '?'}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-gray-300 truncate">{trade.question || 'Unknown'}</p>
          <p className="text-[10px] font-mono text-gray-500 mt-0.5">
            {time} · {edge}% edge
            {isClosed && <span className="text-gray-600"> · closed</span>}
          </p>
        </div>
        <div className="text-right flex-shrink-0">
          <p
            className={`text-xs font-mono font-medium ${profit >= 0 ? 'text-profit' : 'text-loss'}`}
            style={{ textShadow: profit >= 0 ? '0 0 8px rgba(16,185,129,0.2)' : '0 0 8px rgba(239,68,68,0.2)' }}
          >
            {profit >= 0 ? '+' : ''}{profit.toFixed(2)}
          </p>
          <p className="text-[10px] font-mono text-gray-600">${(trade.totalCost || 0).toFixed(0)}</p>
        </div>
      </div>
    </motion.div>
  )
}
