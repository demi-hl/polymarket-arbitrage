import React from 'react'
import { NavLink, Link, useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import { LayoutDashboard, Brain, TrendingUp, Wallet, BarChart3, GitCompare, Settings } from './Icons'

const navItems = [
  { path: '/overview', icon: LayoutDashboard, label: 'Overview' },
  { path: '/paper', icon: GitCompare, label: 'Paper Trading', accent: true },
  { path: '/strategies', icon: Brain, label: 'Strategies' },
  { path: '/markets', icon: TrendingUp, label: 'Markets' },
  { path: '/portfolio', icon: Wallet, label: 'Portfolio' },
  { path: '/backtest', icon: BarChart3, label: 'Backtest' },
]

export default function Sidebar() {
  const location = useLocation()

  return (
    <aside
      className="w-[280px] flex flex-col relative z-20"
      style={{
        background: 'linear-gradient(180deg, rgba(18,18,26,0.95) 0%, rgba(10,10,15,0.98) 100%)',
        borderRight: '1px solid rgba(255,255,255,0.04)',
        backdropFilter: 'blur(24px)',
      }}
    >
      {/* Brand */}
      <div className="px-7 py-7" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
        <Link to="/" className="block hover:opacity-90 transition-opacity">
          <p className="text-sm uppercase tracking-[0.2em] text-gray-400 font-futuristic font-medium">
            Polymarket Bot
          </p>
          <p className="text-xs text-gray-600 tracking-widest uppercase mt-1">
            by DEMI
          </p>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-4 py-6 space-y-1">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path

          return (
            <NavLink
              key={item.path}
              to={item.path}
              className="group relative flex items-center gap-4 px-4 py-3 rounded-xl transition-all duration-300"
              style={{
                background: isActive ? 'rgba(0, 212, 255, 0.08)' : 'transparent',
                color: isActive ? '#00d4ff' : 'rgba(255,255,255,0.4)',
              }}
            >
              {isActive && (
                <motion.div
                  layoutId="nav-indicator"
                  className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-6 rounded-r-full"
                  style={{
                    background: 'linear-gradient(180deg, #00d4ff, #a855f7)',
                    boxShadow: '0 0 14px rgba(0, 212, 255, 0.4)',
                  }}
                  transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                />
              )}

              {!isActive && (
                <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                  style={{ background: 'rgba(255,255,255,0.03)' }}
                />
              )}

              <div className="relative z-10 flex items-center gap-4">
                <item.icon size={20} />
                <span className={`text-[15px] font-medium transition-colors duration-300 ${
                  isActive ? '' : 'group-hover:text-white/70'
                }`}>
                  {item.label}
                </span>
              </div>

              {item.accent && (
                <div className="ml-auto relative z-10">
                  <span className="text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full"
                    style={{
                      background: isActive ? 'rgba(0,212,255,0.12)' : 'rgba(255,255,255,0.04)',
                      color: isActive ? '#00d4ff' : 'rgba(255,255,255,0.25)',
                      border: `1px solid ${isActive ? 'rgba(0,212,255,0.15)' : 'rgba(255,255,255,0.04)'}`,
                    }}
                  >
                    Live
                  </span>
                </div>
              )}
            </NavLink>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="px-4 py-5" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
        <button className="group relative flex items-center gap-4 px-4 py-3 rounded-xl w-full transition-all duration-300"
          style={{ color: 'rgba(255,255,255,0.35)' }}
        >
          <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300"
            style={{ background: 'rgba(255,255,255,0.03)' }}
          />
          <div className="relative z-10 flex items-center gap-4">
            <Settings size={20} />
            <span className="text-[15px] font-medium group-hover:text-white/70 transition-colors">Settings</span>
          </div>
        </button>
      </div>
    </aside>
  )
}
