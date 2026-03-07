import React from 'react'
import { motion } from 'framer-motion'
import { useTrading } from '../context/TradingContext'
// Icons are now type-specific emojis per strategy
import { StaggerContainer, StaggerItem } from '../components/PageTransition'
import PulseRing from '../components/PulseRing'

const STRATEGY_INFO = {
  // ── Core engines ──
  'crypto-latency-arb': 'Rust latency engine — detects Binance vs Polymarket divergence in microseconds',
  'three-way-arbitrage': 'Cross-platform arb — exploits price gaps across Kalshi, PredictIt, Manifold',
  'multi-outcome-arb': 'Multi-outcome event arb — exploits YES-sum deviations on 3+ outcome events',
  'implied-vol-surface': 'Vol surface mispricing — treats crypto markets as binary options, detects IV violations',
  'event-catalyst': 'Time-decay alpha — buys high-conviction outcomes as resolution approaches',
  'resolution-arbitrage': 'Endgame strategy — buys near-certain outcomes (93-99c) within 72hrs of resolution',
  'neg-risk-spread-arb': 'Guaranteed structural arb — buys all outcomes when sum of best asks < $1',
  'gbm-mispricing': 'GBM probability model — geometric Brownian motion detects systematically mispriced contracts',
  // ── Cross-platform ──
  'kalshi-arbitrage': 'Kalshi cross-platform arb — exploits pricing gaps between Polymarket and Kalshi',
  'predictit-arbitrage': 'PredictIt cross-platform arb — finds mispricing vs PredictIt political markets',
  'manifold-arbitrage': 'Manifold cross-platform arb — arbitrage against Manifold play-money odds',
  'metaculus-arbitrage': 'Metaculus cross-platform arb — compares against Metaculus community forecasts',
  'value-betting': 'Value betting — identifies markets where implied probability diverges from true odds',
  'basic-arbitrage': 'Basic arbitrage — detects YES + NO != $1 mispricing on Polymarket',
  // ── Systematic factor suite ──
  'factor-composite-ranker': 'Multi-factor ranking — composite score from momentum, value, and sentiment factors',
  'sentiment-shock': 'Sentiment shock detector — trades sudden X/news sentiment shifts before markets reprice',
  'onchain-flow-leadlag': 'On-chain flow lead-lag — detects whale wallet movements that precede market moves',
  'microstructure-pressure': 'Microstructure pressure — reads order flow imbalance and queue position signals',
  'regime-switch': 'Regime switch detector — identifies market regime changes (trending vs mean-reverting)',
  'var-sharpe-guard': 'VaR/Sharpe guard — risk-adjusted position sizing based on portfolio VaR and Sharpe targets',
  'ranked-portfolio-scout': 'Portfolio scout — scans for portfolio-level arb opportunities across correlated markets',
  // ── Flow & microstructure ──
  'orderbook-scalper': 'Orderbook scalper — captures spread on thick orderbooks with fast fill detection',
  'market-maker': 'Market maker — provides two-sided liquidity on wide-spread markets for spread capture',
  'liquidity-sniper': 'Liquidity sniper — detects large resting orders and trades ahead of fills',
  'volume-spike-detector': 'Volume spike — detects unusual volume surges that precede large price moves',
  'smart-money-detector': 'Smart money tracker — follows high-conviction wallets with proven track records',
  'whale-flow': 'Whale flow — tracks large wallet movements and mirrors high-conviction whale trades',
  // ── Fundamental & technical ──
  'correlated-market-arb': 'Correlated market arb — exploits pricing gaps between correlated prediction markets',
  'ta-momentum': 'Technical momentum — uses RSI, MACD, and Bollinger bands on prediction market price series',
  'news-sentiment': 'News sentiment — NLP analysis of breaking news to trade ahead of market reactions',
  'resolution-frontrun': 'Resolution frontrunner — detects near-resolution markets before final repricing',
  // ── Weather ──
  'weather-forecast': 'Weather forecast arb — compares NOAA/NWS forecasts vs weather market pricing on Polymarket',
  // ── Elections & macro ──
  'elections-polling': 'Elections/polling — compares polling averages and forecasting models vs market-implied odds',
  'economic-data': 'Economic data — trades CPI, unemployment, Fed rate markets using FRED data and consensus estimates',
  // ── Sports ──
  'sports-odds-arb': 'Sports odds arb — cross-references Pinnacle/Betfair sportsbook odds vs Polymarket pricing',
  // ── Alpha & social ──
  'new-market-alpha': 'New market alpha — first-mover trades on newly created markets before pricing reaches efficiency',
  'copy-trade': 'Copy-trade — follows top PnL leaderboard wallets and mirrors high-conviction trades',
}

const TYPE_ICONS = {
  'latency-arbitrage': '⚡',
  'cross-platform': '🌐',
  'fundamental': '📊',
  'statistical': '📈',
  'quant': '🧮',
  'sentiment': '💬',
  'flow': '🌊',
  'microstructure': '🔬',
  'adaptive': '🔄',
  'risk-adjusted': '🛡️',
  'portfolio-construction': '🏗️',
  'probability-model': '🎲',
  'technical': '📉',
  'weather': '🌦️',
  'political': '🗳️',
  'macro': '🏛️',
  'sports': '🏆',
  'alpha': '🚀',
  'social': '👥',
}

const RISK_COLORS = {
  low: { bg: 'rgba(16,185,129,0.08)', text: '#10b981', border: 'rgba(16,185,129,0.2)' },
  medium: { bg: 'rgba(245,158,11,0.08)', text: '#f59e0b', border: 'rgba(245,158,11,0.2)' },
  high: { bg: 'rgba(239,68,68,0.08)', text: '#ef4444', border: 'rgba(239,68,68,0.2)' },
}

export default function Strategies() {
  const { strategies, trades } = useTrading()

  const tradesByStrategy = {}
  let totalTradeCount = 0
  for (const t of (trades || [])) {
    const s = t.strategy || 'unknown'
    if (!tradesByStrategy[s]) tradesByStrategy[s] = { count: 0, pnl: 0, wins: 0 }
    tradesByStrategy[s].count++
    totalTradeCount++
    if (t.realizedPnl != null) {
      tradesByStrategy[s].pnl += t.realizedPnl
      if (t.realizedPnl > 0) tradesByStrategy[s].wins++
    }
  }

  const sorted = [...strategies].sort((a, b) => {
    const aCount = tradesByStrategy[a.name]?.count || 0
    const bCount = tradesByStrategy[b.name]?.count || 0
    return bCount - aCount
  })

  const anim = (delay = 0) => ({
    initial: { opacity: 0, y: 20, filter: 'blur(6px)' },
    animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
    transition: { delay, duration: 0.6, ease: [0.16, 1, 0.3, 1] },
  })

  return (
    <div className="space-y-8">
      <motion.div {...anim(0)}>
        <div className="flex items-center gap-4">
          <h2 className="text-2xl font-bold text-gradient-minimal text-display">Active Strategies</h2>
          <div className="heartbeat-line text-accent/50 mt-1">
            <span /><span /><span /><span /><span /><span />
          </div>
        </div>
        <p className="text-label mt-2">
          {strategies.length} strategies active · {totalTradeCount} total trades
        </p>
      </motion.div>

      <StaggerContainer className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {sorted.map((strategy) => {
          const stats = tradesByStrategy[strategy.name] || { count: 0, pnl: 0, wins: 0 }
          const risk = RISK_COLORS[strategy.riskLevel] || RISK_COLORS.medium
          const winRate = stats.count > 0 ? (stats.wins / stats.count) * 100 : 0
          const pctOfTotal = totalTradeCount > 0 ? (stats.count / totalTradeCount) * 100 : 0

          return (
            <StaggerItem key={strategy.name}>
              <div className="card card-shimmer-hover rounded-xl p-5 transition-all duration-500 hover:border-accent/15 group">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 relative"
                      style={{ background: 'rgba(0,212,255,0.08)', border: '1px solid rgba(0,212,255,0.1)' }}
                    >
                      <span className="text-base">{TYPE_ICONS[strategy.type] || '🧠'}</span>
                      <motion.div
                        className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full"
                        style={{ background: stats.count > 0 ? '#10b981' : '#4b5563', boxShadow: stats.count > 0 ? '0 0 6px rgba(16,185,129,0.5)' : 'none' }}
                        animate={stats.count > 0 ? { opacity: [0.7, 1, 0.7] } : {}}
                        transition={{ repeat: Infinity, duration: 2 }}
                      />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-white capitalize tracking-wide">
                        {strategy.name.replace(/-/g, ' ')}
                      </h3>
                      <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-md font-medium"
                        style={{ background: risk.bg, color: risk.text, border: `1px solid ${risk.border}` }}
                      >
                        {strategy.riskLevel} risk
                      </span>
                    </div>
                  </div>

                  {stats.count > 0 && (
                    <PulseRing
                      value={winRate}
                      max={100}
                      size={44}
                      strokeWidth={2.5}
                      color={stats.pnl >= 0 ? '#10b981' : '#ef4444'}
                      label="win"
                      delay={0}
                    />
                  )}
                </div>

                <p className="text-[11px] text-gray-500 leading-relaxed mb-3">
                  {STRATEGY_INFO[strategy.name] || `${strategy.type} strategy`}
                </p>

                {/* Stats row */}
                <div className="flex items-center gap-4 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                  <div>
                    <span className="text-metric text-sm" style={{ color: stats.count > 0 ? '#00d4ff' : '#4b5563' }}>
                      {stats.count}
                    </span>
                    <span className="text-label ml-1.5">trades</span>
                  </div>
                  {stats.count > 0 && (
                    <>
                      <div>
                        <span className={`text-metric text-sm ${stats.pnl >= 0 ? 'profit-glow' : 'loss-glow'}`}>
                          {stats.pnl >= 0 ? '+' : ''}${stats.pnl.toFixed(2)}
                        </span>
                        <span className="text-label ml-1.5">pnl</span>
                      </div>
                      <div>
                        <span className="text-metric text-sm text-gray-400">
                          {pctOfTotal.toFixed(0)}%
                        </span>
                        <span className="text-label ml-1.5">share</span>
                      </div>
                    </>
                  )}
                  {stats.count === 0 && (
                    <span className="text-[10px] text-gray-600 italic">Waiting for market conditions</span>
                  )}
                </div>
              </div>
            </StaggerItem>
          )
        })}
      </StaggerContainer>
    </div>
  )
}
