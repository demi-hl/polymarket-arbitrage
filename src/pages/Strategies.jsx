import React, { useState } from 'react'
import { useTrading } from '../context/TradingContext'
import { Brain, ToggleLeft, ToggleRight } from '../components/Icons'

const STRATEGY_INFO = {
  'basic-arbitrage': 'Exploits YES+NO pricing inefficiencies',
  'cross-market-arbitrage': 'Arbitrage across Polymarket, Kalshi, PredictIt',
  'temporal-arbitrage': 'Time-based price discrepancies',
  'correlation-arbitrage': 'Statistical relationships between markets',
  'whale-tracker': 'Follows large order flow',
  'resolution-arbitrage': 'Resolution certainty edge',
  'orderbook-scalper': 'Micro-spread scalping',
  'news-sentiment': 'News-driven opportunities',
}

export default function Strategies() {
  const { strategies } = useTrading()
  const [enabledStrategies, setEnabledStrategies] = useState(new Set(strategies.map(s => s.name)))
  
  const toggleStrategy = (name) => {
    setEnabledStrategies(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }
  
  const getRiskColor = (level) => {
    switch (level) {
      case 'low': return 'badge-success'
      case 'medium': return 'badge-warning'
      case 'high': return 'badge-danger'
      default: return 'badge-info'
    }
  }
  
  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">Trading Strategies</h2>
        <div className="text-sm text-gray-400">
          {enabledStrategies.size} / {strategies.length} Active
        </div>
      </div>
      
      <div className="grid grid-cols-2 gap-4">
        {strategies.map((strategy) => (
          <div key={strategy.name} className="card card-hover">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-accent/10 rounded-lg">
                  <Brain size={24} className="text-accent" />
                </div>
                <div>
                  <h3 className="font-semibold capitalize">{strategy.name.replace(/-/g, ' ')}</h3>
                  <span className={`badge ${getRiskColor(strategy.riskLevel)} mt-1`}>
                    {strategy.riskLevel} risk
                  </span>
                </div>
              </div>
              
              <button
                onClick={() => toggleStrategy(strategy.name)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                {enabledStrategies.has(strategy.name) ? (
                  <ToggleRight size={32} className="text-profit" />
                ) : (
                  <ToggleLeft size={32} />
                )}
              </button>
            </div>
            
            <p className="mt-4 text-sm text-gray-400">
              {STRATEGY_INFO[strategy.name] || `${strategy.type} strategy`}
            </p>
            
            <div className="mt-4 flex items-center gap-4 text-xs text-gray-500">
              <span>Type: {strategy.type}</span>
              <span>•</span>
              <span>24h Scans: 0</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
