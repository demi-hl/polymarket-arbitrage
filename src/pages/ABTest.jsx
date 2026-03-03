import React, { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useMultiAccount } from '../context/MultiAccountContext'
import AccountCard from '../components/AccountCard'
import LiveTradeFeed from '../components/LiveTradeFeed'
import EquityCurve from '../components/EquityCurve'

function useAnimatedNumber(value, duration = 600) {
  const [display, setDisplay] = useState(value)
  const prev = useRef(value)
  useEffect(() => {
    const from = prev.current
    const to = value
    prev.current = to
    if (from === to) return
    const start = performance.now()
    function tick(now) {
      const p = Math.min((now - start) / duration, 1)
      const eased = 1 - Math.pow(1 - p, 3)
      setDisplay(from + (to - from) * eased)
      if (p < 1) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, [value, duration])
  return display
}

const THEMES = {
  A: { color: '#f59e0b', label: 'Paper A', sub: 'Paper account' },
  B: { color: '#00d4ff', label: 'Paper B', sub: 'Paper account' },
  paper: { color: '#10b981', label: 'Paper Trading', sub: '20 strategies + Deep Learning + GPU Sentiment' },
}

export default function ABTest() {
  const { accounts, comparison, liveTrades, loading, error, lastUpdate, accountIds } = useMultiAccount()
  const [clock, setClock] = useState(new Date())
  const [selectedDetail, setSelectedDetail] = useState('paper')
  const animatedCombined = useAnimatedNumber(parseFloat(comparison?.combinedValue || 0))

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (accountIds.length > 0 && !accountIds.includes(selectedDetail)) {
      setSelectedDetail(accountIds[0])
    }
  }, [accountIds, selectedDetail])

  if (loading) {
    return (
      <div className="min-h-full flex flex-col items-center justify-center font-futuristic">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center"
        >
          <p className="text-[11px] uppercase tracking-[0.3em] text-gray-500 mb-6">Polymarket bot</p>
          <motion.div
            className="w-12 h-12 mx-auto mb-8 rounded-full"
            style={{
              border: '2px solid rgba(0,212,255,0.2)',
              borderTopColor: '#00d4ff',
            }}
            animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }}
          />
          <p className="text-xl font-light text-gray-300">Loading dashboard...</p>
          <motion.p
            className="text-sm text-gray-600 mt-2"
            animate={{ opacity: [0.3, 0.7, 0.3] }}
            transition={{ repeat: Infinity, duration: 2 }}
          >
            Connecting to trading engine
          </motion.p>
        </motion.div>
      </div>
    )
  }

  if (error && accountIds.length === 0) {
    return (
      <div className="min-h-full flex flex-col items-center justify-center font-futuristic px-6">
        <p className="text-[11px] uppercase tracking-[0.2em] text-gray-500 mb-4">Polymarket bot</p>
        <p className="text-sm text-gray-400 text-center max-w-sm">{error}</p>
        <p className="text-[10px] text-gray-600 mt-4 uppercase tracking-widest">Start watch with ACCOUNT_ID=A and B</p>
      </div>
    )
  }

  const acctA = accounts['A']
  const acctB = accounts['B']
  const winner = comparison?.winner
  const isLive = accountIds.length >= 2
  const combined = comparison?.combinedValue ? parseFloat(comparison.combinedValue) : (acctA?.totalValue || 0) + (acctB?.totalValue || 0)

  const selectedAcct = accounts[selectedDetail]
  const selectedTrades = (liveTrades || []).filter(t => t.accountId === selectedDetail)
  const theme = THEMES[selectedDetail] || { color: '#6b7280', label: `Account ${selectedDetail}`, sub: '' }

  if (!isLive && accountIds.length === 1) {
    const id = accountIds[0]
    const acct = accounts[id]
    const acctTheme = THEMES[id] || { color: '#6b7280', label: `Account ${id}`, sub: 'Single account' }
    const oneCash = acct?.cash || 0
    const oneInvested = Math.max(0, (acct?.totalValue || 0) - oneCash)
    const oneTradeCount = acct?.totalTrades || 0
    const oneOpenCount = acct?.openTradeCount || acct?.openPositions || 0
    return (
      <div className="mx-auto font-futuristic pb-16">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="mb-10"
        >
          <h1 className="text-4xl sm:text-5xl font-light tracking-tight text-white mb-3">
            Paper <span className="text-gradient-minimal">Trading</span>
          </h1>
          <p className="text-base text-gray-500 font-light tracking-wide">
            20 strategies &middot; Deep learning &middot; GPU sentiment &middot; Oracle daemon &middot; Whale tracking &middot; Kelly sizing
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2, duration: 0.5 }}
          className="flex flex-wrap items-center gap-4 sm:gap-8 text-xs uppercase tracking-widest text-gray-500 mb-10 pb-6 relative"
        >
          <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />
          <div className="flex items-center gap-2">
            <motion.div
              className="w-2 h-2 rounded-full"
              style={{ background: '#10b981', boxShadow: '0 0 8px rgba(16,185,129,0.5)' }}
              animate={{ boxShadow: ['0 0 6px rgba(16,185,129,0.4)', '0 0 16px rgba(16,185,129,0.7)', '0 0 6px rgba(16,185,129,0.4)'] }}
              transition={{ repeat: Infinity, duration: 2 }}
            />
            Live
          </div>
          <span className="font-mono tabular-nums text-gray-600">
            {clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
          <span className="font-mono text-gray-500">
            ${oneCash.toLocaleString(undefined, { maximumFractionDigits: 0 })} cash
          </span>
          {oneInvested > 0 && (
            <span className="font-mono text-emerald-500" style={{ textShadow: '0 0 10px rgba(16,185,129,0.2)' }}>
              ${oneInvested.toLocaleString(undefined, { maximumFractionDigits: 0 })} deployed
            </span>
          )}
          {oneTradeCount > 0 && (
            <span className="font-mono text-gray-600">
              {oneTradeCount} trades · {oneOpenCount} open
            </span>
          )}
          {lastUpdate && (
            <span className="text-[10px] text-gray-600 font-mono">
              Updated {new Date(lastUpdate).toLocaleTimeString()}
            </span>
          )}
        </motion.div>

        <div className="relative grid grid-cols-1 gap-8 mb-12">
          <AccountCard accountId={id} data={acct} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-12">
          <div className="lg:col-span-2">
            <EquityCurve accounts={accounts} />
          </div>
          <div>
            <LiveTradeFeed trades={liveTrades} />
          </div>
        </div>

        {acct ? (
          <div className="space-y-6">
            <AccountDetailStats data={acct} theme={acctTheme} />
            <AccountTradeTable trades={selectedTrades} theme={acctTheme} />
          </div>
        ) : (
          <div className="border border-white/[0.04] rounded-lg p-12 text-center">
            <p className="text-sm text-gray-500">No data for account {id}</p>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="mx-auto font-futuristic pb-16">
      <div className="mb-10">
        <h1 className="text-4xl sm:text-5xl font-light tracking-tight text-white mb-3">
          Paper <span className="text-gradient-minimal">Trading</span>
        </h1>
        <p className="text-base text-gray-500 font-light tracking-wide">
          Live paper-trading monitor &middot; Real trades, real time
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4 sm:gap-8 text-[11px] uppercase tracking-widest text-gray-500 mb-10 pb-6 border-b border-white/[0.04]">
        <div className="flex items-center gap-2">
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{
              background: isLive ? '#10b981' : '#6b7280',
              boxShadow: isLive ? '0 0 6px rgba(16,185,129,0.4)' : 'none',
            }}
          />
          {isLive ? 'Live' : 'Standby'}
        </div>
        <span className="font-mono tabular-nums text-gray-600">
          {clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
        <span className="font-mono text-gray-600">
          ${typeof combined === 'number' ? combined.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}
        </span>
        {lastUpdate && (
          <span className="text-[10px] text-gray-600 font-mono">
            Updated {new Date(lastUpdate).toLocaleTimeString()}
          </span>
        )}
      </div>

      {comparison && acctA && acctB && (
        <div className="flex items-center justify-between py-4 mb-8 border-b border-white/[0.04]">
          <p className="text-xs text-gray-400 uppercase tracking-wider">
            {winner === 'tie' ? 'Strategies tied' : `Account ${winner} leading`}
            {winner !== 'tie' && comparison.valueDiff > 0 && (
              <span className="font-mono text-gray-500 ml-2">+${parseFloat(comparison.valueDiff || 0).toFixed(2)}</span>
            )}
          </p>
          <p className="text-sm font-mono text-gray-400">
            Combined <span className="text-white font-medium">${animatedCombined.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </p>
        </div>
      )}

      <div className="relative grid grid-cols-1 lg:grid-cols-2 gap-8 mb-12">
        <AccountCard accountId="A" data={acctA} isWinner={winner === 'A'} />
        <AccountCard accountId="B" data={acctB} isWinner={winner === 'B'} />
        <div className="hidden lg:flex absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-trader-900 border border-white/[0.06] items-center justify-center text-[10px] font-semibold uppercase tracking-wider text-gray-500">
          Live
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-12">
        <div className="lg:col-span-2">
          <EquityCurve accounts={accounts} />
        </div>
        <div>
          <LiveTradeFeed trades={liveTrades} />
        </div>
      </div>

      {/* ── Account Detail Toggle ── */}
      <div className="mb-12">
        <div className="flex items-center justify-between mb-6">
          <p className="text-[11px] uppercase tracking-[0.2em] text-gray-500">Account Detail</p>
          <div className="flex rounded-lg bg-trader-800/60 border border-white/[0.04] p-1 relative">
            {(accountIds?.length ? accountIds : ['A', 'B']).map((id) => (
              <button
                key={id}
                onClick={() => setSelectedDetail(id)}
                className="relative px-5 py-2 rounded-md text-sm font-medium transition-colors z-10 cursor-pointer"
                style={{ color: selectedDetail === id ? '#fff' : 'rgba(255,255,255,0.35)' }}
              >
                {selectedDetail === id && (
                  <motion.div
                    layoutId="ab-detail-pill"
                    className="absolute inset-0 rounded-md"
                    style={{ background: THEMES[id].color + '30', borderColor: THEMES[id].color + '40', borderWidth: 1 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                  />
                )}
                <span className="relative z-10 flex items-center gap-2">
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ background: (THEMES[id]?.color || '#6b7280') }}
                  />
                  {(THEMES[id]?.label || `Account ${id}`)}
                </span>
              </button>
            ))}
          </div>
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={selectedDetail}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          >
            {selectedAcct ? (
              <div className="space-y-6">
                <AccountDetailStats data={selectedAcct} theme={theme} />
                <AccountTradeTable trades={selectedTrades} theme={theme} />
              </div>
            ) : (
              <div className="border border-white/[0.04] rounded-lg p-12 text-center">
                <p className="text-sm text-gray-500">No data for Account {selectedDetail}</p>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {acctA && acctB && (
        <ComparisonTable a={acctA} b={acctB} />
      )}
    </div>
  )
}

function AccountDetailStats({ data, theme }) {
  const realizedPnl = data.pnl?.realized || 0
  const unrealizedPnl = data.pnl?.unrealized || 0
  const liveHitRate = Number.isFinite(data.realisticWinRate) ? data.realisticWinRate : (data.winRate || 0)
  const closedWinRate = Number.isFinite(data.closedWinRate) ? data.closedWinRate : (data.winRate || 0)
  const stats = [
    { label: 'Total Value', value: `$${(data.totalValue || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
    { label: 'Cash', value: `$${(data.cash || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
    { label: 'Realized P&L', value: `${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)}`, positive: realizedPnl >= 0 },
    { label: 'Unrealized P&L', value: `${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(2)}`, positive: unrealizedPnl >= 0 },
    { label: 'Return', value: `${(data.totalReturn || 0) >= 0 ? '+' : ''}${(data.totalReturn || 0).toFixed(2)}%`, positive: (data.totalReturn || 0) >= 0 },
    { label: 'Live Hit Rate', value: data.closedTradeCount > 0 ? `${liveHitRate.toFixed(1)}%` : '—' },
    { label: 'Closed Win Rate', value: data.closedTradeCount > 0 ? `${closedWinRate.toFixed(1)}%` : '—' },
    { label: 'W / L', value: `${data.winCount || 0}W / ${data.lossCount || 0}L` },
    { label: 'Avg Edge', value: `${parseFloat(data.avgEdge || 0).toFixed(2)}%` },
    { label: 'Trades', value: `${data.totalTrades || 0} (${data.closedTradeCount || 0} closed)` },
    { label: 'Open Positions', value: String(data.openPositions || 0) },
  ]

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="card"
      style={{ borderColor: theme.color + '15' }}
    >
      <div className="flex items-center gap-3 mb-5">
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-bold"
          style={{
            background: theme.color + '18',
            color: theme.color,
            border: `1px solid ${theme.color}25`,
            boxShadow: `0 0 12px ${theme.color}15`,
          }}
        >
          {theme.label.split(' ')[1]?.[0] || 'P'}
        </div>
        <span className="text-sm font-medium text-white">{theme.label}</span>
        <span className="text-[10px] text-gray-500 uppercase tracking-wider">{theme.sub}</span>
      </div>
      <div className="grid grid-cols-5 gap-5">
        {stats.map((s, i) => (
          <motion.div
            key={s.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.03 }}
            className="p-3 rounded-lg"
            style={{ background: 'rgba(255,255,255,0.015)', border: '1px solid rgba(255,255,255,0.03)' }}
          >
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5">{s.label}</p>
            <p className={`text-base font-mono font-semibold ${s.positive === true ? 'text-profit' : s.positive === false ? 'text-loss' : 'text-white'}`}
              style={s.positive === true ? { textShadow: '0 0 10px rgba(16,185,129,0.2)' } : s.positive === false ? { textShadow: '0 0 10px rgba(239,68,68,0.2)' } : {}}
            >
              {s.value}
            </p>
          </motion.div>
        ))}
      </div>
    </motion.div>
  )
}

function AccountTradeTable({ trades, theme }) {
  if (!trades || trades.length === 0) {
    return (
      <div className="card text-center py-12">
        <motion.div animate={{ opacity: [0.4, 0.7, 0.4] }} transition={{ repeat: Infinity, duration: 3 }}>
          <p className="text-sm text-gray-500">No trades recorded for this account</p>
        </motion.div>
      </div>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
      className="card overflow-hidden"
      style={{ padding: 0 }}
    >
      <div className="px-6 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
        <p className="text-[11px] uppercase tracking-[0.2em] text-gray-500">
          Trade History
        </p>
        <span className="badge-info text-[10px]">{trades.length} trades</span>
      </div>
      <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
        <table className="w-full text-left">
          <thead className="sticky top-0 glass-panel z-10">
            <tr className="text-[10px] uppercase tracking-wider text-gray-500" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <th className="px-5 py-3 font-semibold">Time</th>
              <th className="px-5 py-3 font-semibold">Market</th>
              <th className="px-5 py-3 font-semibold">Strategy</th>
              <th className="px-5 py-3 font-semibold text-right">Size</th>
              <th className="px-5 py-3 font-semibold text-right">Edge</th>
              <th className="px-5 py-3 font-semibold text-right">P&L</th>
              <th className="px-5 py-3 font-semibold text-center">Status</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade, i) => {
              const hasRealized = trade.realizedPnl != null
              const profit = hasRealized ? trade.realizedPnl : (trade.expectedProfit || 0)
              const status = trade.realizedPnl != null ? 'closed' : (trade.status || 'open')
              const statusColor = status === 'closed'
                ? (profit >= 0 ? 'bg-profit/10 text-profit' : 'bg-loss/10 text-loss')
                : 'bg-yellow-500/10 text-yellow-400'
              return (
                <motion.tr
                  key={trade.id || i}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: Math.min(i * 0.03, 0.4) }}
                  className="border-b border-white/[0.02] hover:bg-white/[0.015] transition-colors"
                >
                  <td className="px-5 py-3 text-sm text-gray-400 whitespace-nowrap font-mono">
                    {trade.timestamp
                      ? new Date(trade.timestamp).toLocaleString(undefined, {
                          month: 'short', day: 'numeric',
                          hour: '2-digit', minute: '2-digit', second: '2-digit',
                        })
                      : '—'}
                  </td>
                  <td className="px-5 py-3 max-w-[280px]">
                    <p className="text-sm text-gray-300 truncate" title={trade.question}>{trade.question}</p>
                  </td>
                  <td className="px-5 py-3">
                    <span
                      className="text-[11px] px-2 py-0.5 rounded-full"
                      style={{ background: theme.color + '10', color: theme.color + 'aa' }}
                    >
                      {trade.strategy || '—'}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-sm font-mono text-gray-300 text-right">
                    ${(trade.totalCost || 0).toFixed(2)}
                  </td>
                  <td className="px-5 py-3 text-sm font-mono text-right" style={{ color: theme.color }}>
                    {trade.edgePercent != null ? `${(trade.edgePercent * 100).toFixed(2)}%` : '—'}
                  </td>
                  <td className={`px-5 py-3 text-sm font-mono text-right ${profit >= 0 ? 'text-profit' : 'text-loss'}`}>
                    {profit >= 0 ? '+' : ''}${profit.toFixed(2)}
                    {!hasRealized && <span className="text-gray-600 ml-1 text-[10px]">est</span>}
                  </td>
                  <td className="px-5 py-3 text-center">
                    <span className={`text-[11px] px-2.5 py-1 rounded-full ${statusColor}`}>
                      {status}
                    </span>
                  </td>
                </motion.tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </motion.div>
  )
}

function ComparisonTable({ a, b }) {
  const metrics = [
    { label: 'Total value', aVal: a.totalValue || 0, bVal: b.totalValue || 0, fmt: v => `$${v.toFixed(2)}` },
    { label: 'Return', aVal: a.totalReturn || 0, bVal: b.totalReturn || 0, fmt: v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` },
    { label: 'Cash', aVal: a.cash || 0, bVal: b.cash || 0, fmt: v => `$${v.toFixed(2)}` },
    { label: 'Realized P&L', aVal: a.pnl?.realized || 0, bVal: b.pnl?.realized || 0, fmt: v => `${v >= 0 ? '+' : ''}$${v.toFixed(2)}` },
    { label: 'Unrealized P&L', aVal: a.pnl?.unrealized || 0, bVal: b.pnl?.unrealized || 0, fmt: v => `${v >= 0 ? '+' : ''}$${v.toFixed(2)}` },
    { label: 'Live hit rate', aVal: (a.realisticWinRate ?? a.winRate ?? 0), bVal: (b.realisticWinRate ?? b.winRate ?? 0), fmt: v => `${v.toFixed(1)}%` },
    { label: 'Closed win rate', aVal: (a.closedWinRate ?? a.winRate ?? 0), bVal: (b.closedWinRate ?? b.winRate ?? 0), fmt: v => `${v.toFixed(1)}%` },
    { label: 'Wins', aVal: a.winCount || 0, bVal: b.winCount || 0, fmt: v => String(Math.round(v)) },
    { label: 'Losses', aVal: a.lossCount || 0, bVal: b.lossCount || 0, fmt: v => String(Math.round(v)), invert: true },
    { label: 'Total trades', aVal: a.totalTrades || 0, bVal: b.totalTrades || 0, fmt: v => String(Math.round(v)) },
    { label: 'Closed', aVal: a.closedTradeCount || 0, bVal: b.closedTradeCount || 0, fmt: v => String(Math.round(v)) },
    { label: 'Open', aVal: a.openPositions || 0, bVal: b.openPositions || 0, fmt: v => String(Math.round(v)) },
    { label: 'Avg edge', aVal: parseFloat(a.avgEdge) || 0, bVal: parseFloat(b.avgEdge) || 0, fmt: v => `${v.toFixed(2)}%` },
    { label: 'Profit factor', aVal: a.profitFactor || 0, bVal: b.profitFactor || 0, fmt: v => v.toFixed(2) },
  ]

  return (
    <div>
      <p className="text-[11px] uppercase tracking-[0.2em] text-gray-500 mb-6">Comparison</p>
      <div className="border-t border-white/[0.04]">
        {metrics.map((m) => {
          const w = m.invert
            ? (m.aVal < m.bVal ? 'A' : m.bVal < m.aVal ? 'B' : null)
            : (m.aVal > m.bVal ? 'A' : m.bVal > m.aVal ? 'B' : null)
          return (
            <div
              key={m.label}
              className="flex items-center justify-between py-3 border-b border-white/[0.03] last:border-b-0"
            >
              <span className="text-[11px] text-gray-500 uppercase tracking-wider">{m.label}</span>
              <div className="flex items-center gap-8">
                <span className={`font-mono text-xs w-20 text-right ${w === 'A' ? 'text-account-a' : 'text-gray-500'}`}>{m.fmt(m.aVal)}</span>
                <span className={`font-mono text-xs w-20 text-right ${w === 'B' ? 'text-account-b' : 'text-gray-500'}`}>{m.fmt(m.bVal)}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
