import React from 'react'
import { useTrading } from '../context/TradingContext'
import { TrendingUp, TrendingDown, Activity, Clock } from '../components/Icons'

export default function Overview() {
  const { portfolio, opportunities, trades, loading } = useTrading()
  
  if (loading) return <div className="text-center py-20 text-gray-400">Loading...</div>
  
  const totalPnl = portfolio?.pnl?.total || 0
  const winRate = portfolio?.trades?.length > 0 
    ? (portfolio.trades.filter(t => (t.realizedPnl || 0) > 0).length / portfolio.trades.length * 100).toFixed(1)
    : 0
  
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Dashboard Overview</h2>
      
      <div className="grid grid-cols-4 gap-4">
        <div className="card card-hover">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-400">Total P&L</p>
              <p className={`text-2xl font-bold ${totalPnl >= 0 ? 'text-profit' : 'text-loss'}`}>
                {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
              </p>
            </div>
            <div className={`p-3 rounded-lg ${totalPnl >= 0 ? 'bg-profit/10' : 'bg-loss/10'}`}>
              {totalPnl >= 0 ? <TrendingUp size={24} className="text-profit" /> : <TrendingDown size={24} className="text-loss" />}
            </div>
          </div>
        </div>
        
        <div className="card card-hover">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-400">Win Rate</p>
              <p className="text-2xl font-bold text-white">{winRate}%</p>
            </div>
            <div className="p-3 rounded-lg bg-accent/10">
              <Activity size={24} className="text-accent" />
            </div>
          </div>
        </div>
        
        <div className="card card-hover">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-400">Open Positions</p>
              <p className="text-2xl font-bold text-white">{portfolio?.openPositions || 0}</p>
            </div>
            <div className="p-3 rounded-lg bg-yellow-500/10">
              <Clock size={24} className="text-yellow-400" />
            </div>
          </div>
        </div>
        
        <div className="card card-hover">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-400">Total Trades</p>
              <p className="text-2xl font-bold text-white">{portfolio?.totalTrades || 0}</p>
            </div>
            <div className="p-3 rounded-lg bg-purple-500/10">
              <TrendingUp size={24} className="text-purple-400" />
            </div>
          </div>
        </div>
      </div>
      
      <div className="grid grid-cols-2 gap-6">
        <div className="card">
          <h3 className="text-lg font-semibold mb-4">Live Opportunities ({opportunities.length})</h3>
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {opportunities.slice(0, 5).map((opp, i) => (
              <div key={i} className="p-3 bg-trader-700 rounded-lg">
                <p className="text-sm font-medium truncate">{opp.question}</p>
                <div className="flex justify-between mt-2 text-xs">
                  <span className="text-profit">+{(opp.edgePercent * 100).toFixed(2)}% edge</span>
                  <span className="text-gray-400">${opp.liquidity?.toLocaleString()} liq</span>
                </div>
              </div>
            ))}
            {opportunities.length === 0 && (
              <p className="text-gray-400 text-center py-8">No opportunities found</p>
            )}
          </div>
        </div>
        
        <div className="card">
          <h3 className="text-lg font-semibold mb-4">Recent Trades</h3>
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {trades.slice(0, 5).map((trade, i) => (
              <div key={i} className="p-3 bg-trader-700 rounded-lg">
                <p className="text-sm font-medium truncate">{trade.question}</p>
                <div className="flex justify-between mt-2 text-xs">
                  <span className={trade.expectedProfit >= 0 ? 'text-profit' : 'text-loss'}>
                    {trade.expectedProfit >= 0 ? '+' : ''}${trade.expectedProfit?.toFixed(2)}
                  </span>
                  <span className="text-gray-400">{new Date(trade.timestamp).toLocaleDateString()}</span>
                </div>
              </div>
            ))}
            {trades.length === 0 && (
              <p className="text-gray-400 text-center py-8">No trades yet</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
