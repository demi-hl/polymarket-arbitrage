import React, { useState } from 'react'
import { BarChart3, Play, Download, Settings } from '../components/Icons'

export default function Backtest() {
  const [strategy, setStrategy] = useState('basic-arbitrage')
  const [startDate, setStartDate] = useState('2024-01-01')
  const [endDate, setEndDate] = useState('2024-12-31')
  const [initialCapital, setInitialCapital] = useState(10000)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState(null)
  
  const runBacktest = async () => {
    setRunning(true)
    setTimeout(() => {
      setResults({
        totalTrades: 156,
        winRate: 68.5,
        netProfit: 2340.50,
        roi: 23.4,
        sharpeRatio: 1.85,
        maxDrawdown: -8.2,
      })
      setRunning(false)
    }, 2000)
  }
  
  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">Strategy Backtest</h2>
        <button className="btn-secondary flex items-center gap-2">
          <Download size={18} />
          Export Results
        </button>
      </div>
      
      <div className="card">
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Settings size={20} />
          Configuration
        </h3>
        
        <div className="grid grid-cols-4 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-2">Strategy</label>
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
              className="input-field w-full"
            >
              <option value="basic-arbitrage">Basic Arbitrage</option>
              <option value="cross-market">Cross Market</option>
              <option value="temporal">Temporal Arbitrage</option>
            </select>
          </div>
          
          <div>
            <label className="block text-sm text-gray-400 mb-2">Start Date</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="input-field w-full"
            />
          </div>
          
          <div>
            <label className="block text-sm text-gray-400 mb-2">End Date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="input-field w-full"
            />
          </div>
          
          <div>
            <label className="block text-sm text-gray-400 mb-2">Initial Capital</label>
            <input
              type="number"
              value={initialCapital}
              onChange={(e) => setInitialCapital(Number(e.target.value))}
              className="input-field w-full"
            />
          </div>
        </div>
        
        <button
          onClick={runBacktest}
          disabled={running}
          className="btn-primary flex items-center gap-2 mt-6"
        >
          <Play size={18} />
          {running ? 'Running...' : 'Run Backtest'}
        </button>
      </div>
      
      {results && (
        <>
          <div className="grid grid-cols-6 gap-4">
            <div className="card text-center">
              <p className="text-sm text-gray-400">Total Trades</p>
              <p className="text-2xl font-bold font-mono">{results.totalTrades}</p>
            </div>
            <div className="card text-center">
              <p className="text-sm text-gray-400">Win Rate</p>
              <p className="text-2xl font-bold font-mono text-profit">{results.winRate}%</p>
            </div>
            <div className="card text-center">
              <p className="text-sm text-gray-400">Net Profit</p>
              <p className="text-2xl font-bold font-mono text-profit">+${results.netProfit}</p>
            </div>
            <div className="card text-center">
              <p className="text-sm text-gray-400">ROI</p>
              <p className="text-2xl font-bold font-mono text-profit">+{results.roi}%</p>
            </div>
            <div className="card text-center">
              <p className="text-sm text-gray-400">Sharpe Ratio</p>
              <p className="text-2xl font-bold font-mono">{results.sharpeRatio}</p>
            </div>
            <div className="card text-center">
              <p className="text-sm text-gray-400">Max Drawdown</p>
              <p className="text-2xl font-bold font-mono text-loss">{results.maxDrawdown}%</p>
            </div>
          </div>
          
          <div className="card">
            <h3 className="text-lg font-semibold mb-4">Equity Curve</h3>
            <div className="h-64 flex items-center justify-center bg-trader-700/30 rounded-lg">
              <p className="text-gray-400">Equity curve visualization would appear here</p>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
