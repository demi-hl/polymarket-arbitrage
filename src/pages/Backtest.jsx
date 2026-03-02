import React, { useState, useEffect } from 'react'
import { BarChart3, Play, Download, Settings } from '../components/Icons'
import useApi from '../hooks/useApi'

export default function Backtest() {
  const [strategy, setStrategy] = useState('basic-arbitrage')
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState(null)
  const [strategies, setStrategies] = useState([])
  const api = useApi()

  useEffect(() => {
    api.get('/strategies').then(res => {
      if (res?.success) setStrategies(res.data || [])
    }).catch(() => {})
  }, [])

  const runBacktest = async () => {
    setRunning(true)
    try {
      const res = await api.get('/report')
      if (res?.success && res.data) {
        const { performance, portfolio, pnl } = res.data
        const totalTrades = performance.totalTrades || 0
        const winRate = parseFloat(performance.winRate) || 0
        const netProfit = pnl?.total || 0
        const roi = parseFloat(portfolio.totalReturn) || 0
        const avgWin = parseFloat(performance.avgWin) || 0
        const avgLoss = parseFloat(performance.avgLoss) || 0
        const profitFactor = parseFloat(performance.profitFactor) || 0

        setResults({
          totalTrades,
          winningTrades: performance.winningTrades || 0,
          losingTrades: performance.losingTrades || 0,
          winRate,
          netProfit,
          roi,
          avgWin,
          avgLoss,
          profitFactor,
          realizedPnl: pnl?.realized || 0,
          unrealizedPnl: pnl?.unrealized || 0,
        })
      }
    } catch (err) {
      console.error('Backtest fetch failed:', err)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">Performance Report</h2>
        <p className="text-xs text-gray-500">Data from live paper trading</p>
      </div>

      <div className="card">
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Settings size={20} />
          Configuration
        </h3>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-2">Strategy Filter</label>
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
              className="input-field w-full"
            >
              <option value="all">All Strategies</option>
              {strategies.map(s => (
                <option key={s.name} value={s.name}>{s.name.replace(/-/g, ' ')}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <button
              onClick={runBacktest}
              disabled={running}
              className="btn-primary flex items-center gap-2"
            >
              <Play size={18} />
              {running ? 'Loading...' : 'Load Report'}
            </button>
          </div>
        </div>
      </div>

      {results && (
        <>
          <div className="grid grid-cols-4 gap-4">
            <div className="card text-center">
              <p className="text-sm text-gray-400">Total Trades</p>
              <p className="text-2xl font-bold font-mono">{results.totalTrades}</p>
              <p className="text-[10px] text-gray-500 mt-1">
                <span className="text-profit">{results.winningTrades}W</span> / <span className="text-loss">{results.losingTrades}L</span>
              </p>
            </div>
            <div className="card text-center">
              <p className="text-sm text-gray-400">Win Rate</p>
              <p className={`text-2xl font-bold font-mono ${results.winRate >= 50 ? 'text-profit' : 'text-loss'}`}>
                {results.winRate.toFixed(1)}%
              </p>
            </div>
            <div className="card text-center">
              <p className="text-sm text-gray-400">Net Profit</p>
              <p className={`text-2xl font-bold font-mono ${results.netProfit >= 0 ? 'text-profit' : 'text-loss'}`}>
                {results.netProfit >= 0 ? '+' : ''}${results.netProfit.toFixed(2)}
              </p>
              <p className="text-[10px] text-gray-500 mt-1">
                Realized: ${results.realizedPnl.toFixed(2)}
              </p>
            </div>
            <div className="card text-center">
              <p className="text-sm text-gray-400">ROI</p>
              <p className={`text-2xl font-bold font-mono ${results.roi >= 0 ? 'text-profit' : 'text-loss'}`}>
                {results.roi >= 0 ? '+' : ''}{results.roi.toFixed(2)}%
              </p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="card text-center">
              <p className="text-sm text-gray-400">Avg Win</p>
              <p className="text-xl font-bold font-mono text-profit">+${results.avgWin.toFixed(2)}</p>
            </div>
            <div className="card text-center">
              <p className="text-sm text-gray-400">Avg Loss</p>
              <p className="text-xl font-bold font-mono text-loss">${results.avgLoss.toFixed(2)}</p>
            </div>
            <div className="card text-center">
              <p className="text-sm text-gray-400">Profit Factor</p>
              <p className={`text-xl font-bold font-mono ${results.profitFactor >= 1 ? 'text-profit' : 'text-loss'}`}>
                {results.profitFactor.toFixed(2)}x
              </p>
            </div>
          </div>
        </>
      )}

      {!results && (
        <div className="card text-center py-16">
          <BarChart3 size={48} className="mx-auto text-gray-600 mb-4" />
          <p className="text-gray-400">Click "Load Report" to see real performance data</p>
          <p className="text-xs text-gray-600 mt-1">Based on actual paper trading results</p>
        </div>
      )}
    </div>
  )
}
