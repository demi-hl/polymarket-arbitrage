import React, { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { TrendingUp, TrendingDown } from './Icons'

const ACCOUNT_THEMES = {
  A: { label: 'Paper A', sub: 'Paper account', color: '#f59e0b' },
  B: { label: 'Paper B', sub: 'Paper account', color: '#00d4ff' },
  paper: { label: 'Paper Trading', sub: '20 strategies + Deep Learning + GPU Sentiment', color: '#10b981' },
}

function fallback(id) {
  return { label: `Account ${id}`, sub: '', color: '#6b7280' }
}

function AnimatedNumber({ value, prefix = '', suffix = '', decimals = 2, className = '', style }) {
  const [display, setDisplay] = useState(value)
  const prev = useRef(value)
  useEffect(() => {
    const from = prev.current
    const to = value
    if (from === to) return
    prev.current = to
    const start = performance.now()
    function tick(now) {
      const p = Math.min((now - start) / 600, 1)
      const eased = 1 - Math.pow(1 - p, 3)
      setDisplay(from + (to - from) * eased)
      if (p < 1) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, [value])
  const formatted = typeof decimals === 'number' ? display.toFixed(decimals) : Math.round(display)
  return <span className={className} style={style}>{prefix}{formatted}{suffix}</span>
}

export default function AccountCard({ accountId, data, isWinner = false }) {
  const theme = ACCOUNT_THEMES[accountId] || fallback(accountId)

  if (!data) {
    return (
      <div className="card shimmer" style={{ minHeight: 220 }}>
        <div className="h-4 w-24 bg-white/5 rounded mb-6" />
        <div className="h-8 w-32 bg-white/5 rounded mb-6" />
        <div className="grid grid-cols-3 gap-4">
          {[1,2,3,4,5,6].map(i => <div key={i} className="h-6 bg-white/5 rounded" />)}
        </div>
      </div>
    )
  }

  const totalValue = data.totalValue || data.cash || 0
  const cash = data.cash || 0
  const invested = Math.max(0, totalValue - cash)
  const totalReturn = data.totalReturn || 0
  const pnl = data.pnl?.total || 0
  const openCount = data.openTradeCount || data.openPositions || 0
  const deployedPct = totalValue > 0 ? ((invested / totalValue) * 100) : 0
  const closedWinRate = data.closedTradeCount > 0 ? (data.closedWinRate ?? data.winRate ?? 0) : 0
  const liveHitRate = Number.isFinite(data.realisticWinRate) ? data.realisticWinRate : closedWinRate
  const openWinCount = data.openWinCount || 0
  const openLossCount = data.openLossCount || 0
  const hasLiveHitRate = (data.winCount || 0) + (data.lossCount || 0) + openWinCount + openLossCount > 0

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className={`card card-hover animated-border ${isWinner ? 'winner-ring' : ''}`}
      style={{
        borderColor: isWinner ? 'rgba(16, 185, 129, 0.2)' : `${theme.color}12`,
        '--accent-color': `${theme.color}80`,
      }}
    >
      <div className="absolute top-0 left-0 right-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${theme.color}40, transparent)` }} />

      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center text-xs font-bold"
            style={{
              background: `${theme.color}15`,
              color: theme.color,
              border: `1px solid ${theme.color}20`,
              boxShadow: `0 0 15px ${theme.color}10`,
            }}
          >
            {accountId.charAt(0).toUpperCase()}
          </div>
          <div>
            <p className="text-sm font-medium text-white">{theme.label}</p>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">{theme.sub}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {isWinner && (
            <span className="text-[10px] uppercase tracking-widest text-profit font-semibold"
              style={{ textShadow: '0 0 8px rgba(16,185,129,0.3)' }}
            >
              Leading
            </span>
          )}
          {openCount > 0 && (
            <span className="text-[10px] uppercase tracking-widest px-2 py-0.5 rounded-full"
              style={{ color: theme.color, background: `${theme.color}10`, border: `1px solid ${theme.color}15` }}
            >
              {openCount} open
            </span>
          )}
        </div>
      </div>

      <div className="flex items-end justify-between mb-6">
        <div>
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5">Total value</p>
          <AnimatedNumber value={totalValue} prefix="$" decimals={2} className="text-3xl font-light font-mono text-white" />
        </div>
        <div className="text-right">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5">Deployed</p>
          <AnimatedNumber value={invested} prefix="$" decimals={2}
            className="text-lg font-light font-mono"
            style={{ color: theme.color, textShadow: `0 0 12px ${theme.color}25` }}
          />
          <span className="text-[10px] text-gray-600 ml-1">({deployedPct.toFixed(0)}%)</span>
        </div>
      </div>

      {invested > 0 && (
        <div className="mb-6">
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.04)' }}>
            <motion.div
              className="h-full rounded-full"
              style={{ background: `linear-gradient(90deg, ${theme.color}, ${theme.color}80)`, boxShadow: `0 0 10px ${theme.color}30` }}
              initial={{ width: 0 }}
              animate={{ width: `${Math.min(deployedPct, 100)}%` }}
              transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-x-6 gap-y-4">
        <Stat label="Total value" value={totalValue} prefix="$" themeColor={theme.color} />
        <Stat label="Realized P&L" value={data.pnl?.realized || 0} prefix={(data.pnl?.realized || 0) >= 0 ? '+$' : '-$'} abs valueClass={(data.pnl?.realized || 0) >= 0 ? 'text-profit' : 'text-loss'} />
        <Stat label="Unrealized P&L" value={data.pnl?.unrealized || 0} prefix={(data.pnl?.unrealized || 0) >= 0 ? '+$' : '-$'} abs valueClass={(data.pnl?.unrealized || 0) >= 0 ? 'text-profit' : 'text-loss'} />
        <Stat label="Live hit rate" value={hasLiveHitRate ? liveHitRate : 0} suffix={hasLiveHitRate ? '%' : ''} decimals={hasLiveHitRate ? 1 : 0} custom={hasLiveHitRate ? null : '—'} />
        <Stat label="Closed W / L" value={0} decimals={0} custom={`${data.winCount || 0}W / ${data.lossCount || 0}L`} />
        <Stat label="Trades" value={data.totalTrades || 0} decimals={0} custom={`${data.closedTradeCount || 0} closed / ${openCount} open`} />
      </div>
      <p className="text-[10px] text-gray-600 mt-3">
        Closed WR: {closedWinRate.toFixed(1)}% · Open M2M bias: {openWinCount} green / {openLossCount} red
      </p>
    </motion.div>
  )
}

function Stat({ label, value, prefix = '', suffix = '', decimals = 2, valueClass = 'text-white', abs = false, custom = null }) {
  const v = abs ? Math.abs(value) : value
  return (
    <div className="p-2.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.015)' }}>
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      {custom ? (
        <span className={`text-sm font-mono font-medium ${valueClass}`}>{custom}</span>
      ) : (
        <AnimatedNumber value={v} prefix={prefix} suffix={suffix} decimals={decimals} className={`text-sm font-mono font-medium ${valueClass}`} />
      )}
    </div>
  )
}
