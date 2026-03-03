import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useTrading } from '../context/TradingContext'
import { Wallet, TrendingUp, TrendingDown, Clock, PieChart } from '../components/Icons'
import { StaggerContainer, StaggerItem } from '../components/PageTransition'
import AnimatedNumber from '../components/AnimatedNumber'

export default function Portfolio() {
  const { portfolio, trades, selectedAccount, setSelectedAccount, accountIds } = useTrading()

  const displayTrades = portfolio?.trades || trades || []

  const totalValue = portfolio?.totalValue || portfolio?.cash || 0
  const totalPnl = portfolio?.pnl?.total || 0
  const realizedPnl = portfolio?.pnl?.realized || 0
  const unrealizedPnl = portfolio?.pnl?.unrealized || 0

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gradient-minimal">Portfolio</h2>
        <div className="flex rounded-lg bg-trader-800 p-1 relative">
          {(accountIds?.length ? accountIds : [selectedAccount]).map((id) => (
            <button
              key={id}
              onClick={() => setSelectedAccount(id)}
              className="relative px-5 py-2 rounded-md text-sm font-medium transition-colors z-10"
              style={{ color: selectedAccount === id ? '#fff' : 'rgba(255,255,255,0.4)' }}
            >
              {selectedAccount === id && (
                <motion.div
                  layoutId="account-pill"
                  className="absolute inset-0 rounded-md"
                  style={{ background: selectedAccount === 'A' ? '#f59e0b' : selectedAccount === 'B' ? '#00d4ff' : '#10b981' }}
                  transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                />
              )}
              <span className="relative z-10">{id === 'paper' ? 'Paper Trading' : `Account ${id}`}</span>
            </button>
          ))}
        </div>
      </div>

      <StaggerContainer className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <StaggerItem>
          <div className="card">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-accent/10 rounded-lg">
                <Wallet className="text-accent" size={24} />
              </div>
              <div>
                <p className="text-sm text-gray-400">Total Value</p>
                <AnimatedNumber value={totalValue} prefix="$" className="text-2xl font-bold font-mono" />
              </div>
            </div>
          </div>
        </StaggerItem>

        <StaggerItem>
          <div className="card">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-profit/10 rounded-lg">
                <TrendingUp className="text-profit" size={24} />
              </div>
              <div>
                <p className="text-sm text-gray-400">Realized P&L</p>
                <AnimatedNumber
                  value={Math.abs(realizedPnl)}
                  prefix={realizedPnl >= 0 ? '+$' : '-$'}
                  className={`text-2xl font-bold font-mono ${realizedPnl >= 0 ? 'text-profit' : 'text-loss'}`}
                />
              </div>
            </div>
          </div>
        </StaggerItem>

        <StaggerItem>
          <div className="card">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-yellow-500/10 rounded-lg">
                <Clock className="text-yellow-400" size={24} />
              </div>
              <div>
                <p className="text-sm text-gray-400">Unrealized P&L</p>
                <AnimatedNumber
                  value={Math.abs(unrealizedPnl)}
                  prefix={unrealizedPnl >= 0 ? '+$' : '-$'}
                  className={`text-2xl font-bold font-mono ${unrealizedPnl >= 0 ? 'text-profit' : 'text-loss'}`}
                />
              </div>
            </div>
          </div>
        </StaggerItem>
      </StaggerContainer>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="card"
        >
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <PieChart size={20} />
            Portfolio Allocation
          </h3>
          <div className="flex items-center justify-center h-48">
            <div className="text-center">
              <motion.div
                className="w-32 h-32 rounded-full border-8 relative"
                style={{ borderColor: selectedAccount === 'A' ? '#f59e0b' : selectedAccount === 'B' ? '#00d4ff' : '#10b981' }}
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.3, type: 'spring', stiffness: 200 }}
              >
                <div className="absolute inset-0 flex items-center justify-center">
                  <AnimatedNumber value={portfolio?.cash || 0} prefix="$" decimals={0} className="text-sm font-bold font-mono" />
                </div>
              </motion.div>
              <p className="mt-4 text-gray-400">Cash Available</p>
              <p className="text-[11px] text-gray-600 mt-1 font-mono">${(portfolio?.cash || 0).toFixed(2)} cash</p>
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="card"
        >
          <h3 className="text-lg font-semibold mb-4">Open Positions</h3>
          <div className="space-y-3 max-h-80 overflow-y-auto">
            <AnimatePresence>
              {Object.values(portfolio?.positions || {})
                .filter(p => p.status === 'open')
                .map((pos, i) => (
                  <motion.div
                    key={pos.marketId || i}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ delay: i * 0.04 }}
                    className="p-3 bg-trader-700 rounded-lg hover:bg-trader-600/60 transition-colors"
                  >
                    <p className="text-sm font-medium truncate">{pos.question}</p>
                    <div className="flex justify-between mt-2 text-xs">
                      <span className="text-gray-400">Entry: ${pos.entryCost?.toFixed(2)}</span>
                      <span className="text-gray-400">
                        {new Date(pos.entryTime).toLocaleDateString()}
                      </span>
                    </div>
                  </motion.div>
                ))}
            </AnimatePresence>
            {Object.values(portfolio?.positions || {}).filter(p => p.status === 'open').length === 0 && (
              <p className="text-gray-400 text-center py-8">No open positions</p>
            )}
          </div>
        </motion.div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="card"
      >
        <h3 className="text-lg font-semibold mb-4">Trade History</h3>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Market</th>
                <th>Strategy</th>
                <th>Size</th>
                <th>Edge</th>
                <th>P&L</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {displayTrades.slice(0, 200).map((trade, i) => {
                const hasRealized = trade.realizedPnl != null
                const pnl = hasRealized ? trade.realizedPnl : (trade.expectedProfit ?? 0)
                const status = hasRealized ? 'closed' : (trade.status || 'open')
                const statusClass = hasRealized
                  ? (pnl >= 0 ? 'badge-success' : 'badge-danger')
                  : 'badge-warning'
                return (
                  <motion.tr
                    key={trade.id || i}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: Math.min(i * 0.02, 0.5) }}
                  >
                    <td className="whitespace-nowrap text-sm text-gray-400">
                      {trade.timestamp
                        ? new Date(trade.timestamp).toLocaleString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })
                        : '—'}
                    </td>
                    <td className="max-w-xs">
                      <p className="truncate" title={trade.question}>{trade.question}</p>
                    </td>
                    <td>
                      <span className="text-[10px] text-accent/70 bg-accent/5 px-1.5 py-0.5 rounded-full">
                        {trade.strategy || '—'}
                      </span>
                    </td>
                    <td className="font-mono text-sm">${(trade.totalCost ?? 0).toFixed(2)}</td>
                    <td className="font-mono text-sm">
                      {trade.edgePercent != null ? `${(trade.edgePercent * 100).toFixed(2)}%` : '—'}
                    </td>
                    <td className={`font-mono text-sm ${pnl >= 0 ? 'text-profit' : 'text-loss'}`}>
                      {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                      {!hasRealized && <span className="text-gray-600 ml-1 text-[9px]">est</span>}
                    </td>
                    <td>
                      <span className={`badge ${statusClass}`}>{status}</span>
                    </td>
                  </motion.tr>
                )
              })}
              {displayTrades.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center py-8 text-gray-400">
                    No trades yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-gray-500">
          Data: Polymarket + Kalshi + PredictIt cross-platform pricing. All trades execute on Polymarket only.
        </p>
      </motion.div>
    </div>
  )
}
