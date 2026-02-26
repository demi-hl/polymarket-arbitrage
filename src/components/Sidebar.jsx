import React from 'react'
import { NavLink } from 'react-router-dom'
import { LayoutDashboard, Brain, TrendingUp, Wallet, BarChart3, Settings } from './Icons'

const navItems = [
  { path: '/', icon: LayoutDashboard, label: 'Overview' },
  { path: '/strategies', icon: Brain, label: 'Strategies' },
  { path: '/markets', icon: TrendingUp, label: 'Markets' },
  { path: '/portfolio', icon: Wallet, label: 'Portfolio' },
  { path: '/backtest', icon: BarChart3, label: 'Backtest' },
]

export default function Sidebar() {
  return (
    <aside className="w-64 bg-trader-800 border-r border-trader-700 flex flex-col">
      <div className="p-6 border-b border-trader-700">
        <h1 className="text-xl font-bold text-gradient">Polymarket Bot</h1>
        <p className="text-xs text-gray-400 mt-1">Arbitrage Trading System</p>
      </div>
      
      <nav className="flex-1 p-4">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) => `
              flex items-center gap-3 px-4 py-3 rounded-lg mb-1 transition-all
              ${isActive 
                ? 'bg-accent/20 text-accent border border-accent/30' 
                : 'text-gray-400 hover:bg-trader-700 hover:text-white'
              }
            `}
          >
            <item.icon size={20} />
            <span className="font-medium">{item.label}</span>
          </NavLink>
        ))}
      </nav>
      
      <div className="p-4 border-t border-trader-700">
        <button className="flex items-center gap-3 px-4 py-3 rounded-lg text-gray-400 hover:bg-trader-700 hover:text-white w-full transition-all">
          <Settings size={20} />
          <span className="font-medium">Settings</span>
        </button>
      </div>
    </aside>
  )
}
