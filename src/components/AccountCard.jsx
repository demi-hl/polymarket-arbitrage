import React, { useEffect, useRef, useState } from 'react'
import { TrendingUp, TrendingDown } from './Icons'

const ACCOUNT_THEMES = {
  A: { label: 'Paper A', sub: 'Paper account', color: '#f59e0b' },
  B: { label: 'Paper B', sub: 'Paper account', color: '#00d4ff' },
  paper: { label: 'Paper Trading', sub: '17 strategies + ML + news sentiment', color: '#10b981' },
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
      <div className="py-8 px-6 border border-white/[0.04] rounded-lg">
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

  return (
    <div
      className="py-6 px-6 rounded-lg border border-white/[0.04] hover:border-white/[0.06] transition-colors"
      style={isWinner ? { borderColor: 'rgba(16, 185, 129, 0.2)' } : {}}
    >
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium"
            style={{ background: `${theme.color}18`, color: theme.color }}
          >
            {accountId.charAt(0).toUpperCase()}
          </div>
          <div>
            <p className="text-sm font-medium text-white">{theme.label}</p>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">{theme.sub}</p>
          </div>
        </div>
        {isWinner && (
          <span className="text-[10px] uppercase tracking-widest text-profit">Leading</span>
        )}
        {openCount > 0 && (
          <span className="text-[10px] uppercase tracking-widest" style={{ color: theme.color }}>
            {openCount} position{openCount !== 1 ? 's' : ''} open
          </span>
        )}
      </div>

      <div className="flex items-end justify-between mb-6">
        <div>
          <p className="text-[11px] text-gray-500 uppercase tracking-wider mb-1">Cash available</p>
          <AnimatedNumber value={cash} prefix="$" decimals={2} className="text-2xl font-light font-mono text-white" />
        </div>
        <div className="text-right">
          <p className="text-[11px] text-gray-500 uppercase tracking-wider mb-1">Deployed</p>
          <AnimatedNumber value={invested} prefix="$" decimals={2} className={`text-lg font-light font-mono`} style={{ color: theme.color }} />
          <span className="text-[10px] text-gray-600 ml-1">({deployedPct.toFixed(0)}%)</span>
        </div>
      </div>

      {invested > 0 && (
        <div className="mb-5">
          <div className="h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{ width: `${Math.min(deployedPct, 100)}%`, background: theme.color }}
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-x-6 gap-y-4">
        <Stat label="Total value" value={totalValue} prefix="$" />
        <Stat label="Realized P&L" value={data.pnl?.realized || 0} prefix={(data.pnl?.realized || 0) >= 0 ? '+$' : '-$'} abs valueClass={(data.pnl?.realized || 0) >= 0 ? 'text-profit' : 'text-loss'} />
        <Stat label="Unrealized P&L" value={data.pnl?.unrealized || 0} prefix={(data.pnl?.unrealized || 0) >= 0 ? '+$' : '-$'} abs valueClass={(data.pnl?.unrealized || 0) >= 0 ? 'text-profit' : 'text-loss'} />
        <Stat label="Win rate" value={data.closedTradeCount > 0 ? (data.winRate || 0) : 0} suffix={data.closedTradeCount > 0 ? '%' : ''} decimals={data.closedTradeCount > 0 ? 1 : 0} custom={data.closedTradeCount > 0 ? null : '—'} />
        <Stat label="W / L" value={0} decimals={0} custom={`${data.winCount || 0}W / ${data.lossCount || 0}L`} />
        <Stat label="Trades" value={data.totalTrades || 0} decimals={0} custom={`${data.closedTradeCount || 0} closed / ${openCount} open`} />
      </div>
    </div>
  )
}

function Stat({ label, value, prefix = '', suffix = '', decimals = 2, valueClass = 'text-white', abs = false, custom = null }) {
  const v = abs ? Math.abs(value) : value
  return (
    <div>
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">{label}</p>
      {custom ? (
        <span className={`text-sm font-mono ${valueClass}`}>{custom}</span>
      ) : (
        <AnimatedNumber value={v} prefix={prefix} suffix={suffix} decimals={decimals} className={`text-sm font-mono ${valueClass}`} />
      )}
    </div>
  )
}
