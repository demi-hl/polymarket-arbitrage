import React from 'react'
import { useTrading } from '../context/TradingContext'
import { Wallet, TrendingUp, TrendingDown, Clock, PieChart } from '../components/Icons'

export default function Portfolio() {
  const { portfolio, trades } = useTrading()
  
  const totalPnl = portfolio?.pnl?.total || 0
  const realizedPnl = portfolio?.pnl?.realized || 0
  const unrealizedPnl = portfolio?.pnl?.unrealized || 0
  
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Portfolio</h2>
      
      <div className="grid grid-cols-3 gap-4">
        <div className="card">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-accent/10 rounded-lg">
              <Wallet className="text-accent" size={24} />
            </div>
            <div>
              <p className="text-sm text-gray-400">Cash Balance</p>
              <p className="text-2xl font-bold font-mono">${(portfolio?.cash || 0).toLocaleString()}</p>
            </div>
          </div>
        </div>
        
        <div className="card">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-profit/10 rounded-lg">
              <TrendingUp className="text-profit" size={24} />
            </div>
            <div>
              <p className="text-sm text-gray-400">Realized P&L</p>
              <p className={`text-2xl font-bold font-mono ${realizedPnl >= 0 ? 'text-profit' : 'text-loss'}`}>
                {realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(2)}
              </p>
            </div>
          </div>
        </div>
        
        <div className="card">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-yellow-500/10 rounded-lg">
              <Clock className="text-yellow-400" size={24} />
            </div>
            <div>
              <p className="text-sm text-gray-400">Unrealized P&L</p>
              <p className={`text-2xl font-bold font-mono ${unrealizedPnl >= 0 ? 'text-profit' : 'text-loss'}`}>
                {unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2)}
              </p>
            </div>
          </div>
        </div>
      </div>
      
      <div className="grid grid-cols-2 gap-6">
        <div className="card">
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <PieChart size={20} />
            Portfolio Allocation
          </h3>
          <div className="flex items-center justify-center h-48">
            <div className="text-center">
              <div className="w-32 h-32 rounded-full border-8 border-accent relative">
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-sm font-bold">${(portfolio?.cash || 0).toLocaleString()}</span>
                </div>
              </div>
              <p className="mt-4 text-gray-400">Cash Available</p>
            </div>
          </div>
        </div>
        
        <div className="card">
          <h3 className="text-lg font-semibold mb-4">Open Positions</h3>
          <div className="space-y-3 max-h-80 overflow-y-auto">
            {Object.values(portfolio?.positions || {})
              .filter(p => p.status === 'open')
              .map((pos, i) => (
                <div key={i} className="p-3 bg-trader-700 rounded-lg">
                  <p className="text-sm font-medium truncate">{pos.question}</p>
                  <div className="flex justify-between mt-2 text-xs">
                    <span className="text-gray-400">Entry: ${pos.entryCost?.toFixed(2)}</span>
                    <span className="text-gray-400">
                      {new Date(pos.entryTime).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              ))}
            {Object.values(portfolio?.positions || {}).filter(p => p.status === 'open').length === 0 && (
              <p className="text-gray-400 text-center py-8">No open positions</p>
            )}
          </div>
        </div>
      </div>
      
      <div className="card">
        <h3 className="text-lg font-semibold mb-4">Trade History</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Market</th>
              <th>Size</th>
              <th>Expected P&L</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(portfolio?.trades || []).slice().reverse().map((trade, i) => (
              <tr key={i}>
                <td>{new Date(trade.timestamp).toLocaleDateString()}</td>
                <td className="max-w-md">
                  <p className="truncate">{trade.question}</p>
                </td>
                <td className="font-mono">${trade.totalCost?.toFixed(2)}</td>
                <td className={`font-mono ${trade.expectedProfit >= 0 ? 'text-profit' : 'text-loss'}`}>
                  {trade.expectedProfit >= 0 ? '+' : ''}${trade.expectedProfit?.toFixed(2)}
                </td>
                <td>
                  <span className="badge badge-success">{trade.status}</span>
                </td>
              </tr>
            ))}
            {(portfolio?.trades || []).length === 0 && (
              <tr>
                <td colSpan={5} className="text-center py-8 text-gray-400">
                  No trades yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
