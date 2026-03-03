import React, { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { useTrading } from '../context/TradingContext'
import { useMultiAccount } from '../context/MultiAccountContext'
import { TrendingUp, TrendingDown, Activity, Clock } from '../components/Icons'
import AnimatedNumber from '../components/AnimatedNumber'

function Skeleton({ className = '' }) {
  return <div className={`shimmer rounded-2xl bg-trader-700/50 ${className}`} />
}

function useOracleData() {
  const [data, setData] = useState(null)
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/oracle/status')
        const json = await res.json()
        if (json.success) setData(json.data)
      } catch {}
    }
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])
  return data
}

function useRealismData() {
  const [data, setData] = useState(null)
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/realism')
        const json = await res.json()
        if (json.success) setData(json.data)
      } catch {}
    }
    load()
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [])
  return data
}

function isRustTrade(trade) {
  return trade?.fillMethod === 'rust-engine'
    || trade?.executedBy === 'rust-engine'
    || trade?.strategy === 'crypto-latency-arb'
    || Boolean(trade?.rustTradeId)
}

export default function Overview() {
  const { portfolio, opportunities, opportunitiesMeta, trades, strategies, loading } = useTrading()
  const { accounts, liveTrades, loading: multiLoading } = useMultiAccount()
  const oracle = useOracleData()
  const realism = useRealismData()
  const [tradeFilter, setTradeFilter] = useState('all')

  // Merge multi-account data so Overview reflects all engines (Node + Rust)
  const multiAcct = (() => {
    const ids = Object.keys(accounts || {})
    if (ids.length === 0) return null
    const all = Object.values(accounts)
    return {
      cash: all.reduce((s, a) => s + (a?.cash || 0), 0),
      totalValue: all.reduce((s, a) => s + (a?.totalValue || 0), 0),
      pnl: {
        realized: all.reduce((s, a) => s + (a?.pnl?.realized || 0), 0),
        unrealized: all.reduce((s, a) => s + (a?.pnl?.unrealized || 0), 0),
        total: all.reduce((s, a) => s + (a?.pnl?.total || 0), 0),
      },
      totalTrades: all.reduce((s, a) => s + (a?.totalTrades || 0), 0),
      closedTradeCount: all.reduce((s, a) => s + (a?.closedTradeCount || 0), 0),
      openTradeCount: all.reduce((s, a) => s + (a?.openTradeCount || 0), 0),
      winCount: all.reduce((s, a) => s + (a?.winCount || 0), 0),
      lossCount: all.reduce((s, a) => s + (a?.lossCount || 0), 0),
    }
  })()

  // Use multi-account data when available (has trades), fall back to TradingContext
  const effectivePortfolio = multiAcct && multiAcct.totalTrades > 0 ? {
    ...portfolio,
    cash: multiAcct.cash,
    totalValue: multiAcct.totalValue,
    pnl: multiAcct.pnl,
    trades: liveTrades || portfolio?.trades || [],
  } : portfolio

  if (loading && !multiAcct) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-12 w-80" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-44" />)}
        </div>
        <div className="grid grid-cols-3 gap-5">
          <Skeleton className="col-span-2 h-[500px]" />
          <Skeleton className="h-[500px]" />
        </div>
      </div>
    )
  }

  const p = effectivePortfolio
  const realizedPnl = p?.pnl?.realized || 0
  const unrealizedPnl = p?.pnl?.unrealized || 0
  const totalPnl = p?.pnl?.total || 0
  const allTrades = p?.trades || []
  const closedTrades = multiAcct ? Array.from({ length: multiAcct.closedTradeCount || 0 }) : allTrades.filter(t => t.realizedPnl != null)
  const openTrades = multiAcct ? Array.from({ length: multiAcct.openTradeCount || 0 }) : allTrades.filter(t => t.realizedPnl == null)
  const wins = multiAcct ? Array.from({ length: multiAcct.winCount || 0 }) : closedTrades.filter(t => t.realizedPnl > 0)
  const losses = multiAcct ? Array.from({ length: multiAcct.lossCount || 0 }) : closedTrades.filter(t => t.realizedPnl < 0)
  const winRate = (multiAcct?.closedTradeCount || closedTrades.length) > 0
    ? ((multiAcct?.winCount || wins.length) / (multiAcct?.closedTradeCount || closedTrades.length)) * 100
    : 0
  const cash = p?.cash || 0
  const totalValue = p?.totalValue || cash
  const invested = Math.max(0, totalValue - cash)
  // Compute stats from real trade objects (liveTrades has actual data)
  const realClosedTrades = (liveTrades || allTrades).filter(t => t?.realizedPnl != null)
  const realWins = realClosedTrades.filter(t => t.realizedPnl > 0)
  const realLosses = realClosedTrades.filter(t => t.realizedPnl < 0)
  const avgWin = realWins.length > 0 ? realWins.reduce((s, t) => s + t.realizedPnl, 0) / realWins.length : 0
  const avgLoss = realLosses.length > 0 ? realLosses.reduce((s, t) => s + t.realizedPnl, 0) / realLosses.length : 0
  const profitFactor = Math.abs(avgLoss) > 0 ? (avgWin / Math.abs(avgLoss)) : 0
  const bestTrade = realClosedTrades.length > 0 ? Math.max(...realClosedTrades.map(t => t.realizedPnl)) : 0
  const worstTrade = realClosedTrades.length > 0 ? Math.min(...realClosedTrades.map(t => t.realizedPnl)) : 0

  const strategyBreakdown = {}
  // Seed from the /strategies API so all registered strategies appear
  ;(strategies || []).forEach(s => {
    const name = s?.name || s?.id
    if (name && !strategyBreakdown[name]) {
      strategyBreakdown[name] = { count: 0, pnl: 0, wins: 0, active: s?.enabled !== false }
    }
  })
  ;(liveTrades || allTrades).forEach(t => {
    const s = t.strategy || 'unknown'
    if (!strategyBreakdown[s]) strategyBreakdown[s] = { count: 0, pnl: 0, wins: 0, active: true }
    strategyBreakdown[s].count++
    if (t.realizedPnl != null) {
      strategyBreakdown[s].pnl += t.realizedPnl
      if (t.realizedPnl > 0) strategyBreakdown[s].wins++
    }
  })
  const topStrategies = Object.entries(strategyBreakdown)
    .sort((a, b) => b[1].count - a[1].count || (b[1].active ? 1 : 0) - (a[1].active ? 1 : 0))
    .slice(0, 10)
  const filteredRecentTrades = (liveTrades || trades || []).filter(trade => {
    if (tradeFilter === 'rust') return isRustTrade(trade)
    if (tradeFilter === 'node') return !isRustTrade(trade)
    return true
  })
  const parseNum = (v, fallback = 0) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }


  const anim = (delay = 0) => ({
    initial: { opacity: 0, y: 20, filter: 'blur(6px)' },
    animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
    transition: { delay, duration: 0.6, ease: [0.16, 1, 0.3, 1] },
  })

  return (
    <div className="space-y-8">
      <motion.div {...anim(0)}>
        <h2 className="text-4xl font-extralight tracking-tight text-gradient-minimal">Dashboard</h2>
        <p className="text-[13px] text-gray-500 mt-2.5 tracking-wide font-light">
          29 strategies · Deep learning · GPU sentiment · Oracle daemon · Whale tracking · Kelly sizing
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          <span className="text-[10px] uppercase tracking-wider text-gray-500">Paper→live gap</span>
          <span
            className="text-[11px] font-mono px-2 py-0.5 rounded-full border"
            style={{
              color: realism?.score >= 80 ? '#10b981' : realism?.score >= 65 ? '#f59e0b' : '#ef4444',
              borderColor: realism?.score >= 80 ? 'rgba(16,185,129,0.3)' : realism?.score >= 65 ? 'rgba(245,158,11,0.35)' : 'rgba(239,68,68,0.35)',
              background: realism?.score >= 80 ? 'rgba(16,185,129,0.08)' : realism?.score >= 65 ? 'rgba(245,158,11,0.08)' : 'rgba(239,68,68,0.08)',
            }}
          >
            {realism?.score != null ? `${realism.score}/100` : 'warming up'}
          </span>
          {realism?.sampleSize > 0 && (
            <span className="text-[10px] text-gray-600 font-mono">
              n={realism.sampleSize} · MAE ${realism.maeUsd}
            </span>
          )}
          {realism?.score != null && realism.score < 65 && (
            <span className="text-[10px] text-gray-600">
              — slippage/latency widen paper vs live
            </span>
          )}
        </div>
        <div
          className="mt-4 rounded-xl p-3 sm:p-4 border"
          style={{
            background: 'rgba(255,255,255,0.02)',
            borderColor: realism?.projection?.riskFlag === 'green'
              ? 'rgba(16,185,129,0.24)'
              : realism?.projection?.riskFlag === 'yellow'
                ? 'rgba(245,158,11,0.28)'
                : 'rgba(239,68,68,0.28)',
          }}
        >
          <div className="flex flex-wrap items-center gap-2.5 sm:gap-3 text-[10px] uppercase tracking-wider">
            <span className="text-gray-500">Projection (adjusted for slippage)</span>
            <span
              className="text-[10px] px-2 py-0.5 rounded-full border font-mono"
              style={{
                color: realism?.projection?.confidence === 'high' ? '#10b981' : realism?.projection?.confidence === 'medium' ? '#f59e0b' : '#9ca3af',
                borderColor: realism?.projection?.confidence === 'high' ? 'rgba(16,185,129,0.28)' : realism?.projection?.confidence === 'medium' ? 'rgba(245,158,11,0.3)' : 'rgba(156,163,175,0.25)',
                background: 'rgba(255,255,255,0.02)',
              }}
            >
              {realism?.projection?.available ? `${realism.projection.confidence} sample size` : 'warming up'}
            </span>
            {realism?.projection?.sampleSize > 0 && (
              <span className="text-gray-600 font-mono">n={realism.projection.sampleSize}</span>
            )}
          </div>
          {realism?.projection?.available ? (
            <div className="mt-2.5 grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
              <div className="rounded-lg px-3 py-2 bg-black/20 border border-white/[0.05]">
                <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Est live win rate</p>
                <p className="font-mono text-white">
                  {realism.projection.estimatedWinRateLow}% - {realism.projection.estimatedWinRateHigh}%
                </p>
              </div>
              <div className="rounded-lg px-3 py-2 bg-black/20 border border-white/[0.05]">
                <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Projected net PnL/trade</p>
                <p className={`font-mono ${realism.projection.projectedNetPnlPerTrade >= 0 ? 'text-profit' : 'text-loss'}`}>
                  {realism.projection.projectedNetPnlPerTrade >= 0 ? '+' : ''}
                  ${realism.projection.projectedNetPnlPerTrade}
                  <span className="text-gray-500 text-[10px] ml-2">
                    ({realism.projection.projectedNetPnlPerTradeLow >= 0 ? '+' : ''}{realism.projection.projectedNetPnlPerTradeLow}
                    {' '}to{' '}
                    {realism.projection.projectedNetPnlPerTradeHigh >= 0 ? '+' : ''}{realism.projection.projectedNetPnlPerTradeHigh})
                  </span>
                </p>
              </div>
            </div>
          ) : (
            <p className="mt-2.5 text-[11px] text-gray-500">Need more comparable Rust paper samples before we can estimate live performance.</p>
          )}
          {realism?.projection?.note && (
            <p className="mt-2 text-[11px] text-gray-500">{realism.projection.note}</p>
          )}
        </div>
      </motion.div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
        <motion.div {...anim(0.05)} className="card card-hover animated-border stat-card" style={{ '--accent-color': totalPnl >= 0 ? 'rgba(16,185,129,0.5)' : 'rgba(239,68,68,0.5)' }}>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wider mb-3">Total P&L</p>
              <AnimatedNumber value={Math.abs(totalPnl)} prefix={totalPnl >= 0 ? '+$' : '-$'} className={`text-4xl font-bold font-mono ${totalPnl >= 0 ? 'profit-glow' : 'loss-glow'}`} decimals={2} />
              <div className="flex gap-4 mt-3">
                <span className={`text-xs font-mono ${realizedPnl >= 0 ? 'text-profit/70' : 'text-loss/70'}`}>{realizedPnl >= 0 ? '+' : ''}{realizedPnl.toFixed(2)} real</span>
                <span className={`text-xs font-mono ${unrealizedPnl >= 0 ? 'text-profit/70' : 'text-loss/70'}`}>{unrealizedPnl >= 0 ? '+' : ''}{unrealizedPnl.toFixed(2)} unreal</span>
              </div>
            </div>
            <motion.div
              className={`p-4 rounded-xl ${totalPnl >= 0 ? 'bg-profit/10' : 'bg-loss/10'}`}
              animate={{ scale: [1, 1.05, 1] }}
              transition={{ repeat: Infinity, duration: 3, ease: 'easeInOut' }}
            >
              {totalPnl >= 0 ? <TrendingUp size={28} className="text-profit" /> : <TrendingDown size={28} className="text-loss" />}
            </motion.div>
          </div>
        </motion.div>

        <motion.div {...anim(0.1)} className="card card-hover animated-border stat-card" style={{ '--accent-color': 'rgba(16,185,129,0.5)' }}>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wider mb-3">Portfolio</p>
              <AnimatedNumber value={totalValue} prefix="$" className="text-4xl font-bold font-mono text-white" decimals={0} />
              <div className="flex gap-4 mt-3">
                <span className="text-xs font-mono text-gray-500">${Math.round(cash).toLocaleString()} cash</span>
                <span className="text-xs font-mono text-emerald-400/80">${Math.round(invested).toLocaleString()} deployed</span>
              </div>
            </div>
            <div className="p-4 rounded-xl bg-emerald-500/10">
              <TrendingUp size={28} className="text-emerald-400" />
            </div>
          </div>
        </motion.div>

        <motion.div {...anim(0.15)} className="card card-hover animated-border stat-card" style={{ '--accent-color': 'rgba(0,212,255,0.5)' }}>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wider mb-3">Win Rate</p>
              {closedTrades.length > 0 ? (
                <>
                  <AnimatedNumber value={winRate} suffix="%" decimals={1} className="text-4xl font-bold font-mono text-white" />
                  <div className="w-full h-1.5 rounded-full mt-4 overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                    <motion.div
                      className="h-full rounded-full"
                      style={{ background: 'linear-gradient(90deg, #00d4ff, #10b981)' }}
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.min(winRate, 100)}%` }}
                      transition={{ delay: 0.5, duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
                    />
                  </div>
                </>
              ) : (
                <span className="text-4xl font-bold font-mono text-gray-600">&mdash;</span>
              )}
              <div className="flex gap-4 mt-3">
                <span className="text-xs font-mono text-profit">{wins.length}W</span>
                <span className="text-xs font-mono text-loss">{losses.length}L</span>
                <span className="text-xs font-mono text-gray-500">{openTrades.length} open</span>
              </div>
            </div>
            <div className="p-4 rounded-xl bg-accent/10">
              <Activity size={28} className="text-accent" />
            </div>
          </div>
        </motion.div>

        <motion.div {...anim(0.2)} className="card card-hover animated-border stat-card" style={{ '--accent-color': 'rgba(168,85,247,0.5)' }}>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wider mb-3">Trades</p>
              <AnimatedNumber value={portfolio?.totalTrades || 0} decimals={0} className="text-4xl font-bold font-mono text-white" />
              <div className="flex gap-4 mt-3">
                <span className="text-xs font-mono text-gray-500">{closedTrades.length} closed</span>
                <span className="text-xs font-mono text-gray-500">{openTrades.length} open</span>
              </div>
            </div>
            <div className="p-4 rounded-xl bg-purple-500/10">
              <Clock size={28} className="text-purple-400" />
            </div>
          </div>
        </motion.div>
      </div>

      <motion.div {...anim(0.25)} className="grid grid-cols-3 lg:grid-cols-6 gap-4">
        {[
          { label: 'Avg Win', value: avgWin > 0 ? `+$${avgWin.toFixed(2)}` : '—', color: 'text-profit' },
          { label: 'Avg Loss', value: avgLoss < 0 ? `$${avgLoss.toFixed(2)}` : '—', color: 'text-loss' },
          { label: 'Profit Factor', value: profitFactor > 0 ? profitFactor.toFixed(2) : '—', color: 'text-white' },
          { label: 'Best Trade', value: bestTrade > 0 ? `+$${bestTrade.toFixed(2)}` : '—', color: 'text-profit' },
          { label: 'Worst Trade', value: worstTrade < 0 ? `$${worstTrade.toFixed(2)}` : '—', color: 'text-loss' },
          { label: 'Deployed %', value: totalValue > 0 ? `${((invested / totalValue) * 100).toFixed(0)}%` : '—', color: 'text-accent' },
        ].map((s, i) => (
          <motion.div
            key={s.label}
            whileHover={{ scale: 1.03, y: -2 }}
            transition={{ type: 'spring', stiffness: 400, damping: 25 }}
            className="rounded-xl p-4 cursor-default"
            style={{
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid rgba(255,255,255,0.04)',
              transition: 'border-color 0.3s, box-shadow 0.3s',
            }}
          >
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5">{s.label}</p>
            <p className={`text-lg font-mono font-semibold ${s.color}`}>{s.value}</p>
          </motion.div>
        ))}
      </motion.div>

      <div className="grid grid-cols-1 gap-6">
        <motion.div {...anim(0.3)} className="card">
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-xl font-semibold">
              Recent Trades
              {closedTrades.length > 0 && (
                <span className={`ml-3 text-base font-mono ${realizedPnl >= 0 ? 'profit-glow' : 'loss-glow'}`}>
                  {realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(2)}
                </span>
              )}
            </h3>
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
                      layoutId="overview-trade-toggle"
                      className="absolute inset-0 rounded-md border"
                      style={{ background: 'rgba(0,212,255,0.15)', borderColor: 'rgba(0,212,255,0.35)' }}
                      transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                    />
                  )}
                  <span className="relative z-10">{opt.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2.5 max-h-[520px] overflow-y-auto pr-1">
            {filteredRecentTrades.slice(0, 12).map((trade, i) => {
              const hasRealized = trade.realizedPnl != null
              const pnl = hasRealized ? trade.realizedPnl : (trade.expectedProfit || 0)
              return (
                <motion.div
                  key={trade.id || i}
                  initial={{ opacity: 0, x: 12, filter: 'blur(4px)' }}
                  animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
                  transition={{ delay: 0.4 + i * 0.04, duration: 0.5 }}
                  whileHover={{ x: -4, backgroundColor: 'rgba(0, 212, 255, 0.03)' }}
                  className="p-4 rounded-xl transition-colors"
                  style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.03)' }}
                >
                  <div className="flex items-center gap-3 mb-2">
                    <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${hasRealized ? (pnl >= 0 ? 'bg-profit' : 'bg-loss') : 'bg-yellow-400'}`}
                      style={{
                        boxShadow: hasRealized
                          ? (pnl >= 0 ? '0 0 8px rgba(16,185,129,0.5)' : '0 0 8px rgba(239,68,68,0.5)')
                          : '0 0 8px rgba(250,204,21,0.5)',
                      }}
                    />
                    <p className="text-sm font-medium truncate flex-1 text-gray-200">{trade.question}</p>
                    {trade.strategy && <span className="text-[10px] text-accent/60 bg-accent/5 px-2 py-0.5 rounded-full border border-accent/10 whitespace-nowrap">{trade.strategy}</span>}
                  </div>
                  <div className="flex justify-between text-xs pl-5">
                    <span className={`font-mono font-semibold ${pnl >= 0 ? 'text-profit' : 'text-loss'}`} style={{ textShadow: pnl >= 0 ? '0 0 10px rgba(16,185,129,0.25)' : '0 0 10px rgba(239,68,68,0.25)' }}>
                      {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                      <span className="text-gray-600 ml-2 font-normal text-[10px]">{hasRealized ? 'realized' : 'est'}</span>
                    </span>
                    <div className="flex items-center gap-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${hasRealized ? (pnl >= 0 ? 'bg-profit/10 text-profit/80' : 'bg-loss/10 text-loss/80') : 'bg-yellow-500/10 text-yellow-400/80'}`}>
                        {hasRealized ? 'closed' : 'open'}
                      </span>
                      <span className="text-gray-500">{trade.timestamp ? new Date(trade.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</span>
                    </div>
                  </div>
                </motion.div>
              )
            })}
            {filteredRecentTrades.length === 0 && (
              <div className="text-center py-16">
                <p className="text-gray-500 text-base">
                  {trades.length === 0 ? 'No trades yet' : `No ${tradeFilter} trades yet`}
                </p>
              </div>
            )}
          </div>
        </motion.div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <motion.div {...anim(0.4)} className="card">
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-xl font-semibold">Strategy Breakdown</h3>
            <span className="text-[10px] text-gray-500 font-mono">{topStrategies.length} strategies</span>
          </div>
          <div className="space-y-2.5 max-h-[520px] overflow-y-auto pr-1">
            {topStrategies.map(([name, data], i) => {
              const wr = data.count > 0 && data.wins > 0 ? ((data.wins / data.count) * 100).toFixed(0) : '—'
              const maxCount = Math.max(...topStrategies.map(([, d]) => d.count), 1)
              const hasTrades = data.count > 0
              return (
                <motion.div
                  key={name}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.45 + i * 0.03 }}
                  className="strategy-bar flex items-center justify-between p-3.5 rounded-xl relative"
                  style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.03)', opacity: hasTrades ? 1 : 0.5 }}
                >
                  {hasTrades && (
                    <div className="absolute left-0 top-0 bottom-0 rounded-xl opacity-[0.04]"
                      style={{
                        width: `${(data.count / maxCount) * 100}%`,
                        background: data.pnl >= 0
                          ? 'linear-gradient(90deg, rgba(16,185,129,0.8), transparent)'
                          : 'linear-gradient(90deg, rgba(239,68,68,0.8), transparent)',
                      }}
                    />
                  )}
                  <div className="flex items-center gap-3 relative z-10">
                    <span className="text-accent/60 bg-accent/5 px-2.5 py-1 rounded-lg text-[11px] font-mono border border-accent/10">{name}</span>
                    {!hasTrades && data.active && (
                      <span className="text-[9px] text-gray-600 uppercase tracking-wider">idle</span>
                    )}
                  </div>
                  <div className="flex items-center gap-5 text-xs font-mono relative z-10">
                    <span className="text-gray-400">{hasTrades ? `${data.count} trades` : '—'}</span>
                    <span className="text-gray-500 w-12 text-right">{wr}% wr</span>
                    <span className={`w-20 text-right ${hasTrades ? (data.pnl >= 0 ? 'text-profit' : 'text-loss') : 'text-gray-600'}`} style={hasTrades ? { textShadow: data.pnl >= 0 ? '0 0 8px rgba(16,185,129,0.2)' : '0 0 8px rgba(239,68,68,0.2)' } : {}}>
                      {hasTrades ? `${data.pnl >= 0 ? '+' : ''}$${data.pnl.toFixed(2)}` : '—'}
                    </span>
                  </div>
                </motion.div>
              )
            })}
            {topStrategies.length === 0 && <p className="text-gray-500 text-center py-8">No strategy data yet</p>}
          </div>
        </motion.div>

        <motion.div {...anim(0.45)} className="card">
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-xl font-semibold">Oracle Intelligence</h3>
            {oracle?.stats?.lastRun && (
              <span className="text-[10px] text-gray-600 font-mono">{new Date(oracle.stats.lastRun).toLocaleTimeString()}</span>
            )}
          </div>
          {oracle ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                {[
                  { value: oracle.activeTheses || 0, label: 'Active Theses', color: '0, 212, 255', textColor: 'text-accent' },
                  { value: oracle.recentWhaleSignals || 0, label: 'Whale Signals', color: '245, 158, 11', textColor: 'text-amber-400' },
                  { value: oracle.stats?.totalRuns || 0, label: 'Scan Cycles', color: '168, 85, 247', textColor: 'text-purple-400' },
                ].map((item, i) => (
                  <motion.div
                    key={item.label}
                    whileHover={{ scale: 1.04, y: -2 }}
                    className="rounded-xl p-3 text-center cursor-default"
                    style={{
                      background: `rgba(${item.color}, 0.04)`,
                      border: `1px solid rgba(${item.color}, 0.1)`,
                    }}
                  >
                    <p className={`text-2xl font-bold font-mono ${item.textColor}`}
                      style={{ textShadow: `0 0 15px rgba(${item.color}, 0.3)` }}
                    >
                      {item.value}
                    </p>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider mt-1">{item.label}</p>
                  </motion.div>
                ))}
              </div>
              {(oracle.theses || []).length > 0 && (
                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider">Recent Theses</p>
                  {(oracle.theses || []).slice(-6).reverse().map((t, i) => (
                    <motion.div
                      key={t.id || i}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.5 + i * 0.04 }}
                      className="p-3 rounded-xl text-xs strategy-bar"
                      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.03)' }}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className={`font-mono font-semibold ${t.bias?.includes('BUY_YES') || t.direction === 'BUY_YES' ? 'text-profit' : t.bias?.includes('BUY_NO') || t.direction === 'BUY_NO' ? 'text-loss' : 'text-gray-400'}`}>
                          {t.direction || t.bias || '—'}
                        </span>
                        <span className="text-[10px] text-gray-600">{t.source || 'manual'}</span>
                      </div>
                      <p className="text-gray-400 text-[11px] truncate">{t.rationale || t.notes || t.keywords?.join(', ')}</p>
                    </motion.div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-12">
              <motion.div animate={{ opacity: [0.4, 0.7, 0.4] }} transition={{ repeat: Infinity, duration: 3 }}>
                <p className="text-gray-500">Oracle daemon not connected</p>
                <p className="text-gray-600 text-sm mt-1">Start the bot watcher to enable</p>
              </motion.div>
            </div>
          )}
        </motion.div>
      </div>
    </div>
  )
}
