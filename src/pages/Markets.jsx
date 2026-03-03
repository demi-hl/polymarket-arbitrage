import React, { useState } from 'react'
import { useTrading } from '../context/TradingContext'
import { Search, ArrowUpDown } from '../components/Icons'

export default function Markets() {
  const { opportunities, executeTrade, opportunitiesMeta } = useTrading()
  const [search, setSearch] = useState('')
  const [minEdge, setMinEdge] = useState(5)
  const [sortBy, setSortBy] = useState('edge')
  
  const filtered = opportunities
    .filter(o => {
      const matchesSearch = o.question?.toLowerCase().includes(search.toLowerCase())
      const matchesEdge = (o.edgePercent * 100) >= minEdge
      return matchesSearch && matchesEdge
    })
    .sort((a, b) => {
      if (sortBy === 'edge') return b.edgePercent - a.edgePercent
      if (sortBy === 'liquidity') return b.liquidity - a.liquidity
      return 0
    })
  
  const handleExecute = async (opp) => {
    const res = await executeTrade(opp.marketId, opp.maxPosition)
    if (res.success) {
      alert('Trade executed!')
    } else {
      alert('Trade failed: ' + res.error)
    }
  }
  
  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row gap-4 lg:gap-0 lg:justify-between lg:items-center">
        <h2 className="text-2xl font-bold text-gradient-minimal">Market Explorer</h2>
        <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3 sm:gap-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
            <input
              type="text"
              placeholder="Search markets..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input-field pl-10 w-full sm:w-64"
            />
          </div>
          
          <select
            value={minEdge}
            onChange={(e) => setMinEdge(Number(e.target.value))}
            className="input-field"
          >
            <option value={0}>All Edges</option>
            <option value={5}>5%+ Edge</option>
            <option value={10}>10%+ Edge</option>
            <option value={15}>15%+ Edge</option>
          </select>
          
          <button
            onClick={() => setSortBy(sortBy === 'edge' ? 'liquidity' : 'edge')}
            className="btn-secondary flex items-center gap-2"
          >
            <ArrowUpDown size={18} />
            Sort by {sortBy === 'edge' ? 'Liquidity' : 'Edge'}
          </button>
        </div>
      </div>

      {opportunitiesMeta?.stale && (
        <div
          className="rounded-lg px-4 py-3 text-sm"
          style={{
            background: 'rgba(250, 204, 21, 0.08)',
            border: '1px solid rgba(250, 204, 21, 0.25)',
            color: 'rgba(250, 204, 21, 0.95)',
          }}
        >
          Live opportunities are temporarily stale. Showing cached results while the scanner catches up.
          {opportunitiesMeta?.warning ? (
            <span className="block text-xs mt-1 text-yellow-300/80">
              Reason: {opportunitiesMeta.warning}
            </span>
          ) : null}
        </div>
      )}
      
      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Market</th>
              <th>Edge</th>
              <th>YES Prob</th>
              <th>NO Prob</th>
              <th>Prob Sum</th>
              <th>Liquidity</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((opp, i) => (
              <tr key={i}>
                <td className="max-w-md">
                  <p className="font-medium truncate">{opp.question}</p>
                  <p className="text-xs text-gray-500">{opp.slug}</p>
                </td>
                <td>
                  <span className="text-profit font-mono">
                    +{(opp.edgePercent * 100).toFixed(2)}%
                  </span>
                </td>
                <td className="font-mono">{((opp.yesPrice || 0) * 100).toFixed(1)}%</td>
                <td className="font-mono">{((opp.noPrice || 0) * 100).toFixed(1)}%</td>
                <td className={`font-mono ${opp.sum < 1 ? 'text-profit' : 'text-loss'}`}>
                  {((opp.sum || 0) * 100).toFixed(1)}%
                </td>
                <td className="font-mono">${opp.liquidity?.toLocaleString()}</td>
                <td>
                  <button
                    onClick={() => handleExecute(opp)}
                    className="btn-primary text-sm py-1 px-3"
                  >
                    Execute
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center py-8 text-gray-400">
                  No opportunities found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
