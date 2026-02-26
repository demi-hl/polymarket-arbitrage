import React from 'react'
import { useTrading } from '../context/TradingContext'
import { Activity, Wifi, WifiOff, DollarSign } from './Icons'

export default function Header() {
  const { portfolio, systemStatus, opportunities } = useTrading()
  
  const totalPnl = portfolio?.pnl?.total || 0
  const openPositions = portfolio?.openPositions || 0
  
  return (
    <header className="h-16 bg-trader-800 border-b border-trader-700 flex items-center justify-between px-6">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2">
          <Activity size={20} className="text-accent" />
          <span className="font-semibold">Live Trading</span>
        </div>
        
        <div className="flex items-center gap-2 text-sm">
          {systemStatus.connected ? (
            <>
              <Wifi size={16} className="text-profit" />
              <span className="text-gray-400">Connected</span>
            </>
          ) : (
            <>
              <WifiOff size={16} className="text-loss" />
              <span className="text-gray-400">Disconnected</span>
            </>
          )}
        </div>
        
        <div className="flex items-center gap-2 text-sm">
          <span className="w-2 h-2 rounded-full bg-profit animate-pulse" />
          <span className="text-gray-400">{opportunities.length} Opportunities</span>
        </div>
      </div>
      
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-xs text-gray-400">Open Positions</p>
            <p className="font-mono font-semibold">{openPositions}</p>
          </div>
          <div className="w-px h-8 bg-trader-600" />
          <div className="text-right">
            <p className="text-xs text-gray-400">Total P&L</p>
            <p className={`font-mono font-semibold ${totalPnl >= 0 ? 'text-profit' : 'text-loss'}`}>
              {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-2 px-4 py-2 bg-trader-700 rounded-lg">
          <DollarSign size={16} className="text-gray-400" />
          <span className="font-mono font-semibold">
            ${(portfolio?.cash || 0).toLocaleString()}
          </span>
        </div>
      </div>
    </header>
  )
}
