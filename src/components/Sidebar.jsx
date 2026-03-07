import React from 'react'
import { NavLink, Link, useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import { LayoutDashboard, Brain, TrendingUp, Wallet, BarChart3, GitCompare, Settings, CopyTrade, Newspaper } from './Icons'

const navItems = [
  { path: '/overview', icon: LayoutDashboard, label: 'Overview', healthDot: 'live' },
  { path: '/paper', icon: GitCompare, label: 'Paper Trading', accent: true, healthDot: 'live' },
  { path: '/strategies', icon: Brain, label: 'Strategies', healthDot: 'live' },
  { path: '/markets', icon: TrendingUp, label: 'Markets' },
  { path: '/portfolio', icon: Wallet, label: 'Portfolio' },
  { path: '/whales', icon: CopyTrade, label: 'Copy Trading', healthDot: 'live' },
  { path: '/news', icon: Newspaper, label: 'News Scanner', healthDot: 'idle' },
  { path: '/backtest', icon: BarChart3, label: 'Backtest' },
]

export default function Sidebar() {
  const location = useLocation()

  return (
    <aside
      className="w-[320px] flex flex-col relative z-20"
      style={{
        background: 'linear-gradient(180deg, rgba(14,14,22,0.97) 0%, rgba(6,6,10,0.99) 100%)',
        borderRight: '1px solid rgba(255,255,255,0.04)',
        backdropFilter: 'blur(40px) saturate(1.4)',
      }}
    >
      <div className="absolute right-0 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-accent/10 to-transparent" />
      <div className="absolute left-0 top-0 right-0 h-32 pointer-events-none" style={{ background: 'linear-gradient(180deg, rgba(0,212,255,0.02) 0%, transparent 100%)' }} />

      <div className="px-7 py-8 relative" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
        <Link to="/" className="block group">
          <div className="flex items-center gap-4">
            <motion.div
              className="w-11 h-11 rounded-xl flex items-center justify-center relative overflow-hidden"
              style={{
                background: 'linear-gradient(135deg, rgba(0,212,255,0.15), rgba(168,85,247,0.10))',
                border: '1px solid rgba(0,212,255,0.15)',
                boxShadow: '0 0 24px rgba(0,212,255,0.08)',
              }}
              whileHover={{ scale: 1.08, boxShadow: '0 0 30px rgba(0,212,255,0.15)' }}
              transition={{ type: 'spring', stiffness: 400, damping: 20 }}
            >
              <motion.div
                className="w-4 h-4 rounded-sm"
                style={{ background: 'linear-gradient(135deg, #00d4ff, #a855f7)' }}
                animate={{ rotate: [0, 90, 0] }}
                transition={{ repeat: Infinity, duration: 8, ease: 'easeInOut' }}
              />
              <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
                style={{ background: 'radial-gradient(circle at center, rgba(0,212,255,0.15), transparent 70%)' }}
              />
            </motion.div>
            <div>
              <p className="text-[17px] uppercase tracking-[0.22em] font-futuristic font-bold group-hover:text-white transition-colors duration-300 text-gradient-minimal">
                LOCALS ONLY
              </p>
              <p className="text-[10px] text-gray-500 tracking-[0.15em] uppercase mt-1 font-medium">
                Polymarket Arb Engine
              </p>
            </div>
          </div>
        </Link>
      </div>

      <nav className="flex-1 px-4 py-6 space-y-1">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path

          return (
            <NavLink
              key={item.path}
              to={item.path}
              className="sidebar-item-glow group relative flex items-center gap-4 px-4 py-3.5 rounded-xl transition-all duration-300"
              style={{
                background: isActive ? 'rgba(0, 212, 255, 0.06)' : 'transparent',
                color: isActive ? '#00d4ff' : 'rgba(255,255,255,0.4)',
              }}
            >
              {isActive && (
                <motion.div
                  layoutId="nav-indicator"
                  className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-7 rounded-r-full"
                  style={{
                    background: 'linear-gradient(180deg, #00d4ff, #a855f7)',
                    boxShadow: '0 0 18px rgba(0, 212, 255, 0.5), 0 0 40px rgba(0, 212, 255, 0.15)',
                  }}
                  transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                />
              )}

              <div className="relative z-10 flex items-center gap-4">
                <motion.div
                  animate={isActive ? { scale: [1, 1.1, 1] } : {}}
                  transition={{ duration: 0.4 }}
                >
                  <item.icon size={20} />
                </motion.div>
                <span className={`text-[15px] font-medium transition-all duration-300 ${
                  isActive ? '' : 'group-hover:text-white/80'
                }`}>
                  {item.label}
                </span>
                {item.healthDot && (
                  <motion.div
                    className="w-1.5 h-1.5 rounded-full ml-auto"
                    style={{
                      background: item.healthDot === 'live' ? '#10b981' : '#4b5563',
                      boxShadow: item.healthDot === 'live' ? '0 0 6px rgba(16,185,129,0.5)' : 'none',
                    }}
                    animate={item.healthDot === 'live' ? { opacity: [0.7, 1, 0.7] } : {}}
                    transition={{ repeat: Infinity, duration: 3 }}
                  />
                )}
              </div>

              {item.accent && (
                <div className="ml-auto relative z-10">
                  <span className="text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full relative overflow-hidden"
                    style={{
                      background: isActive ? 'rgba(0,212,255,0.1)' : 'rgba(255,255,255,0.03)',
                      color: isActive ? '#00d4ff' : 'rgba(255,255,255,0.25)',
                      border: `1px solid ${isActive ? 'rgba(0,212,255,0.2)' : 'rgba(255,255,255,0.04)'}`,
                      boxShadow: isActive ? '0 0 12px rgba(0,212,255,0.1)' : 'none',
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

      <div className="px-5 py-4" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
        <div className="flex items-center justify-between px-3 py-2 mb-3">
          <span className="text-[10px] uppercase tracking-widest text-gray-600 font-mono">v3.0.0</span>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-profit" style={{ boxShadow: '0 0 6px rgba(16,185,129,0.5)' }} />
            <span className="text-[10px] text-gray-600 uppercase tracking-wider">GPU</span>
          </div>
        </div>
        <NavLink
          to="/settings"
          className="sidebar-item-glow group relative flex items-center gap-4 px-4 py-3 rounded-xl w-full transition-all duration-300"
          style={({ isActive }) => ({ color: isActive ? '#00d4ff' : 'rgba(255,255,255,0.35)', background: isActive ? 'rgba(0,212,255,0.06)' : 'transparent' })}
        >
          <div className="relative z-10 flex items-center gap-4">
            <Settings size={20} />
            <span className="text-[15px] font-medium group-hover:text-white/80 transition-colors duration-300">Settings</span>
          </div>
        </NavLink>
      </div>
    </aside>
  )
}
