import React, { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { useTrading } from '../context/TradingContext'
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

export default function Overview() {
  const { portfolio, opportunities, trades, loading } = useTrading()
  const oracle = useOracleData()

  if (loading) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-12 w-80" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-40" />)}
        </div>
        <div className="grid grid-cols-3 gap-5">
          <Skeleton className="col-span-2 h-[500px]" />
          <Skeleton className="h-[500px]" />
        </div>
      </div>
    )
  }

  const realizedPnl = portfolio?.pnl?.realized || 0
  const unrealizedPnl = portfolio?.pnl?.unrealized || 0
  const totalPnl = portfolio?.pnl?.total || 0
  const allTrades = portfolio?.trades || []
  const closedTrades = allTrades.filter(t => t.realizedPnl != null)
  const openTrades = allTrades.filter(t => t.realizedPnl == null)
  const wins = closedTrades.filter(t => t.realizedPnl > 0)
  const losses = closedTrades.filter(t => t.realizedPnl < 0)
  const winRate = closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0
  const cash = portfolio?.cash || 0
  const totalValue = portfolio?.totalValue || cash
  const invested = Math.max(0, totalValue - cash)
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.realizedPnl, 0) / wins.length : 0
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.realizedPnl, 0) / losses.length : 0
  const profitFactor = Math.abs(avgLoss) > 0 ? (avgWin / Math.abs(avgLoss)) : 0
  const bestTrade = closedTrades.length > 0 ? Math.max(...closedTrades.map(t => t.realizedPnl)) : 0
  const worstTrade = closedTrades.length > 0 ? Math.min(...closedTrades.map(t => t.realizedPnl)) : 0

  const strategyBreakdown = {}
  allTrades.forEach(t => {
    const s = t.strategy || 'unknown'
    if (!strategyBreakdown[s]) strategyBreakdown[s] = { count: 0, pnl: 0, wins: 0 }
    strategyBreakdown[s].count++
    if (t.realizedPnl != null) {
      strategyBreakdown[s].pnl += t.realizedPnl
      if (t.realizedPnl > 0) strategyBreakdown[s].wins++
    }
  })
  const topStrategies = Object.entries(strategyBreakdown)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 6)

  const anim = (delay = 0) => ({
    initial: { opacity: 0, y: 16 },
    animate: { opacity: 1, y: 0 },
    transition: { delay, duration: 0.5, ease: [0.16, 1, 0.3, 1] },
  })

  return (
    <div className="space-y-8">
      {/* Header */}
      <motion.div {...anim(0)}>
        <h2 className="text-4xl font-bold tracking-tight">Dashboard</h2>
        <p className="text-base text-gray-500 mt-2">
          17 strategies &middot; ML scoring &middot; Oracle daemon &middot; whale tracking &middot; news sentiment &middot; Kelly sizing
        </p>
      </motion.div>

      {/* Row 1: 4 big stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
        <motion.div {...anim(0.05)} className="card card-hover stat-card" style={{ '--accent-color': totalPnl >= 0 ? 'rgba(16,185,129,0.5)' : 'rgba(239,68,68,0.5)' }}>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-gray-400 mb-3">Total P&L</p>
              <AnimatedNumber value={Math.abs(totalPnl)} prefix={totalPnl >= 0 ? '+$' : '-$'} className={`text-4xl font-bold font-mono ${totalPnl >= 0 ? 'text-profit' : 'text-loss'}`} decimals={2} />
              <div className="flex gap-4 mt-3">
                <span className={`text-xs font-mono ${realizedPnl >= 0 ? 'text-profit/60' : 'text-loss/60'}`}>{realizedPnl >= 0 ? '+' : ''}{realizedPnl.toFixed(2)} real</span>
                <span className={`text-xs font-mono ${unrealizedPnl >= 0 ? 'text-profit/60' : 'text-loss/60'}`}>{unrealizedPnl >= 0 ? '+' : ''}{unrealizedPnl.toFixed(2)} unreal</span>
              </div>
            </div>
            <div className={`p-4 rounded-xl ${totalPnl >= 0 ? 'bg-profit/10' : 'bg-loss/10'}`}>
              {totalPnl >= 0 ? <TrendingUp size={28} className="text-profit" /> : <TrendingDown size={28} className="text-loss" />}
            </div>
          </div>
        </motion.div>

        <motion.div {...anim(0.1)} className="card card-hover stat-card" style={{ '--accent-color': 'rgba(16,185,129,0.5)' }}>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-gray-400 mb-3">Portfolio</p>
              <AnimatedNumber value={totalValue} prefix="$" className="text-4xl font-bold font-mono text-white" decimals={0} />
              <div className="flex gap-4 mt-3">
                <span className="text-xs font-mono text-gray-500">${Math.round(cash).toLocaleString()} cash</span>
                <span className="text-xs font-mono text-emerald-400">${Math.round(invested).toLocaleString()} deployed</span>
              </div>
            </div>
            <div className="p-4 rounded-xl bg-emerald-500/10">
              <TrendingUp size={28} className="text-emerald-400" />
            </div>
          </div>
        </motion.div>

        <motion.div {...anim(0.15)} className="card card-hover stat-card" style={{ '--accent-color': 'rgba(0,212,255,0.5)' }}>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-gray-400 mb-3">Win Rate</p>
              {closedTrades.length > 0 ? (
                <AnimatedNumber value={winRate} suffix="%" decimals={1} className="text-4xl font-bold font-mono text-white" />
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

        <motion.div {...anim(0.2)} className="card card-hover stat-card" style={{ '--accent-color': 'rgba(168,85,247,0.5)' }}>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-gray-400 mb-3">Trades</p>
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

      {/* Row 2: Secondary stats strip */}
      <motion.div {...anim(0.25)} className="grid grid-cols-3 lg:grid-cols-6 gap-4">
        {[
          { label: 'Avg Win', value: avgWin > 0 ? `+$${avgWin.toFixed(2)}` : '—', color: 'text-profit' },
          { label: 'Avg Loss', value: avgLoss < 0 ? `$${avgLoss.toFixed(2)}` : '—', color: 'text-loss' },
          { label: 'Profit Factor', value: profitFactor > 0 ? profitFactor.toFixed(2) : '—', color: 'text-white' },
          { label: 'Best Trade', value: bestTrade > 0 ? `+$${bestTrade.toFixed(2)}` : '—', color: 'text-profit' },
          { label: 'Worst Trade', value: worstTrade < 0 ? `$${worstTrade.toFixed(2)}` : '—', color: 'text-loss' },
          { label: 'Deployed %', value: totalValue > 0 ? `${((invested / totalValue) * 100).toFixed(0)}%` : '—', color: 'text-accent' },
        ].map((s, i) => (
          <div key={s.label} className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{s.label}</p>
            <p className={`text-lg font-mono font-semibold ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </motion.div>

      {/* Row 3: Opportunities + Trades side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <motion.div {...anim(0.3)} className="card">
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-xl font-semibold">Live Opportunities</h3>
            <span className="badge-info text-sm">{opportunities.length}</span>
          </div>
          <div className="space-y-2.5 max-h-[520px] overflow-y-auto pr-1">
            {(opportunities || []).slice(0, 12).map((opp, i) => (
              <motion.div
                key={opp?.marketId || i}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.35 + i * 0.03 }}
                className="p-4 rounded-xl hover:bg-white/[0.03] transition-colors"
                style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.03)' }}
              >
                <p className="text-sm font-medium truncate text-gray-200">{opp?.question ?? '—'}</p>
                <div className="flex justify-between items-center mt-2">
                  <div className="flex items-center gap-3">
                    <span className="text-profit text-sm font-mono font-bold">+{((opp?.edgePercent ?? 0) * 100).toFixed(2)}%</span>
                    {opp?.direction && <span className="text-[10px] text-gray-500 font-mono">{opp.direction}</span>}
                  </div>
                  <div className="flex items-center gap-3">
                    {opp?.strategy && <span className="text-[10px] text-accent/50 bg-accent/5 px-2 py-0.5 rounded-full">{opp.strategy}</span>}
                    <span className="text-[11px] text-gray-500 font-mono">${(opp?.liquidity ?? 0).toLocaleString()}</span>
                  </div>
                </div>
              </motion.div>
            ))}
            {opportunities.length === 0 && (
              <div className="text-center py-16">
                <p className="text-gray-500 text-base">No opportunities</p>
                <p className="text-gray-600 text-sm mt-1">Waiting for next scan cycle</p>
              </div>
            )}
          </div>
        </motion.div>

        <motion.div {...anim(0.35)} className="card">
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-xl font-semibold">
              Recent Trades
              {closedTrades.length > 0 && (
                <span className={`ml-3 text-base font-mono ${realizedPnl >= 0 ? 'text-profit' : 'text-loss'}`}>
                  {realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(2)}
                </span>
              )}
            </h3>
          </div>
          <div className="space-y-2.5 max-h-[520px] overflow-y-auto pr-1">
            {(trades || []).slice(-12).reverse().map((trade, i) => {
              const hasRealized = trade.realizedPnl != null
              const pnl = hasRealized ? trade.realizedPnl : (trade.expectedProfit || 0)
              return (
                <motion.div
                  key={trade.id || i}
                  initial={{ opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.4 + i * 0.03 }}
                  className="p-4 rounded-xl hover:bg-white/[0.03] transition-colors"
                  style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.03)' }}
                >
                  <div className="flex items-center gap-3 mb-2">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${hasRealized ? (pnl >= 0 ? 'bg-profit' : 'bg-loss') : 'bg-yellow-400'}`}
                      style={{ boxShadow: hasRealized ? (pnl >= 0 ? '0 0 6px rgba(16,185,129,0.4)' : '0 0 6px rgba(239,68,68,0.4)') : '0 0 6px rgba(250,204,21,0.4)' }}
                    />
                    <p className="text-sm font-medium truncate flex-1 text-gray-200">{trade.question}</p>
                    {trade.strategy && <span className="text-[10px] text-accent/50 bg-accent/5 px-2 py-0.5 rounded-full whitespace-nowrap">{trade.strategy}</span>}
                  </div>
                  <div className="flex justify-between text-xs pl-5">
                    <span className={`font-mono font-semibold ${pnl >= 0 ? 'text-profit' : 'text-loss'}`}>
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
            {trades.length === 0 && (
              <div className="text-center py-16">
                <p className="text-gray-500 text-base">No trades yet</p>
              </div>
            )}
          </div>
        </motion.div>
      </div>

      {/* Row 4: Strategy breakdown + Oracle intel */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Strategy performance */}
        <motion.div {...anim(0.4)} className="card">
          <h3 className="text-xl font-semibold mb-5">Strategy Breakdown</h3>
          <div className="space-y-3">
            {topStrategies.map(([name, data], i) => {
              const wr = data.count > 0 && data.wins > 0 ? ((data.wins / data.count) * 100).toFixed(0) : '—'
              return (
                <div key={name} className="flex items-center justify-between p-3 rounded-xl" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.03)' }}>
                  <div className="flex items-center gap-3">
                    <span className="text-accent/50 bg-accent/5 px-2.5 py-1 rounded-lg text-[11px] font-mono">{name}</span>
                  </div>
                  <div className="flex items-center gap-6 text-xs font-mono">
                    <span className="text-gray-400">{data.count} trades</span>
                    <span className="text-gray-500">{wr}% wr</span>
                    <span className={data.pnl >= 0 ? 'text-profit' : 'text-loss'}>{data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(2)}</span>
                  </div>
                </div>
              )
            })}
            {topStrategies.length === 0 && <p className="text-gray-500 text-center py-8">No strategy data yet</p>}
          </div>
        </motion.div>

        {/* Oracle intel */}
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
                <div className="rounded-xl p-3 text-center" style={{ background: 'rgba(0,212,255,0.04)', border: '1px solid rgba(0,212,255,0.08)' }}>
                  <p className="text-2xl font-bold font-mono text-accent">{oracle.activeTheses || 0}</p>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mt-1">Active Theses</p>
                </div>
                <div className="rounded-xl p-3 text-center" style={{ background: 'rgba(245,158,11,0.04)', border: '1px solid rgba(245,158,11,0.08)' }}>
                  <p className="text-2xl font-bold font-mono text-amber-400">{oracle.recentWhaleSignals || 0}</p>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mt-1">Whale Signals</p>
                </div>
                <div className="rounded-xl p-3 text-center" style={{ background: 'rgba(168,85,247,0.04)', border: '1px solid rgba(168,85,247,0.08)' }}>
                  <p className="text-2xl font-bold font-mono text-purple-400">{oracle.stats?.totalRuns || 0}</p>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mt-1">Scan Cycles</p>
                </div>
              </div>
              {(oracle.theses || []).length > 0 && (
                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider">Recent Theses</p>
                  {(oracle.theses || []).slice(-6).reverse().map((t, i) => (
                    <div key={t.id || i} className="p-3 rounded-xl text-xs" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.03)' }}>
                      <div className="flex items-center justify-between mb-1">
                        <span className={`font-mono font-semibold ${t.bias?.includes('BUY_YES') || t.direction === 'BUY_YES' ? 'text-profit' : t.bias?.includes('BUY_NO') || t.direction === 'BUY_NO' ? 'text-loss' : 'text-gray-400'}`}>
                          {t.direction || t.bias || '—'}
                        </span>
                        <span className="text-[10px] text-gray-600">{t.source || 'manual'}</span>
                      </div>
                      <p className="text-gray-400 text-[11px] truncate">{t.rationale || t.notes || t.keywords?.join(', ')}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-12">
              <p className="text-gray-500">Oracle daemon not connected</p>
              <p className="text-gray-600 text-sm mt-1">Start the bot watcher to enable</p>
            </div>
          )}
        </motion.div>
      </div>
    </div>
  )
}
