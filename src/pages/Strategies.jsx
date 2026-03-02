import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { useTrading } from '../context/TradingContext'
import { Brain, ToggleLeft, ToggleRight } from '../components/Icons'
import { StaggerContainer, StaggerItem } from '../components/PageTransition'

const STRATEGY_INFO = {
  'multi-outcome-arb': 'Multi-outcome event arbitrage — exploits YES-sum deviations on 3+ outcome events',
  'basic-arbitrage': 'Exploits YES+NO pricing inefficiencies on binary markets',
  'resolution-arbitrage': 'Endgame strategy — buys near-certain outcomes (93-99¢) within 72hrs of resolution',
  'kalshi-arbitrage': 'Kalshi vs Polymarket cross-platform price gaps',
  'predictit-arbitrage': 'PredictIt vs Polymarket cross-platform price gaps',
  'three-way-arbitrage': 'Three-way cross-platform arbitrage (Kalshi + PredictIt + Polymarket)',
  'value-betting': 'Kelly-criterion sized bets on fundamental value vs market price divergence',
  'market-maker': 'Automated market making with bid-ask spread capture',
  'orderbook-scalper': 'CLOB depth imbalance and spread scalping',
  'correlated-market-arb': 'Logical inconsistency detection — trades when correlated markets violate probability constraints',
  'neg-risk-spread-arb': 'Guaranteed structural arb — buys all outcomes in neg-risk events when sum of asks < $1',
  'volume-spike-detector': 'Follows informed flow — detects volume spikes and trades in the direction of smart money',
  'ta-momentum': 'Technical analysis — EMA/RSI/Bollinger bands for momentum & mean-reversion signals on prediction markets',
  'liquidity-sniper': 'Exploits thin orderbook levels — trades through imbalanced bid/ask depth for spread capture',
  'event-catalyst': 'Time-decay alpha — buys high-conviction outcomes as resolution approaches within 72 hours',
  'smart-money-detector': 'Whale flow following — detects coordinated large trades and rides the smart money direction',
  'news-sentiment': 'News-driven contrarian trades — matches breaking events against curated directional theses (geopolitics, ETFs, shutdowns)',
}

const RISK_COLORS = {
  low: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  medium: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  high: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
}

export default function Strategies() {
  const { strategies, trades } = useTrading()
  const [enabledStrategies, setEnabledStrategies] = useState(new Set(strategies.map(s => s.name)))

  const toggleStrategy = (name) => {
    setEnabledStrategies(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const tradesByStrategy = {}
  for (const t of (trades || [])) {
    const s = t.strategy || 'unknown'
    if (!tradesByStrategy[s]) tradesByStrategy[s] = []
    tradesByStrategy[s].push(t)
  }

  const grouped = {}
  for (const s of strategies) {
    const type = s.type || 'other'
    if (!grouped[type]) grouped[type] = []
    grouped[type].push(s)
  }

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold">Trading Strategies</h2>
          <p className="text-xs text-gray-500 mt-1">
            {enabledStrategies.size} / {strategies.length} active · all strategies scanned every cycle
          </p>
        </div>
      </div>

      {Object.entries(grouped).map(([type, strats]) => (
        <div key={type}>
          <p className="text-[11px] uppercase tracking-[0.2em] text-gray-500 mb-4">{type}</p>
          <StaggerContainer className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {strats.map((strategy) => {
              const enabled = enabledStrategies.has(strategy.name)
              const stratTrades = tradesByStrategy[strategy.name] || []
              const riskClass = RISK_COLORS[strategy.riskLevel] || RISK_COLORS.medium
              return (
                <StaggerItem key={strategy.name}>
                  <div className={`rounded-lg border p-4 transition-colors ${enabled ? 'border-white/[0.06] bg-white/[0.02]' : 'border-white/[0.03] bg-transparent opacity-50'}`}>
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
                          <Brain size={16} className="text-accent" />
                        </div>
                        <div>
                          <h3 className="text-sm font-medium text-white capitalize">{strategy.name.replace(/-/g, ' ')}</h3>
                          <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${riskClass}`}>
                            {strategy.riskLevel}
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => toggleStrategy(strategy.name)}
                        className="text-gray-400 hover:text-white transition-colors flex-shrink-0"
                      >
                        {enabled ? <ToggleRight size={28} className="text-profit" /> : <ToggleLeft size={28} />}
                      </button>
                    </div>
                    <p className="text-[11px] text-gray-500 leading-relaxed mb-2">
                      {STRATEGY_INFO[strategy.name] || `${strategy.type} strategy`}
                    </p>
                    {stratTrades.length > 0 && (
                      <p className="text-[10px] font-mono text-gray-600">
                        {stratTrades.length} trade{stratTrades.length !== 1 ? 's' : ''} · ${stratTrades.reduce((s, t) => s + (t.totalCost || 0), 0).toFixed(0)} deployed
                      </p>
                    )}
                  </div>
                </StaggerItem>
              )
            })}
          </StaggerContainer>
        </div>
      ))}
    </div>
  )
}
