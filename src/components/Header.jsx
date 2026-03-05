import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useTrading } from '../context/TradingContext'
import { useWallet } from '../context/WalletContext'
import ConnectWallet from './ConnectWallet'
import { Bell, BellOff } from './Icons'

function useNotifications() {
  const [enabled, setEnabled] = useState(() => {
    try { return localStorage.getItem('demi_notifications') !== 'off' } catch { return true }
  })
  const toggle = () => {
    const next = !enabled
    setEnabled(next)
    try { localStorage.setItem('demi_notifications', next ? 'on' : 'off') } catch {}
    // Expose globally so TradingContext can check
    window.__demiNotifications = next
  }
  useEffect(() => { window.__demiNotifications = enabled }, [enabled])
  return { enabled, toggle }
}

export default function Header({ minimal = false }) {
  const [clock, setClock] = useState(new Date())
  const { portfolio, systemStatus, loading } = useTrading()
  const { address } = useWallet()
  const notifications = useNotifications()

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const isLive = !loading && systemStatus?.connected

  if (minimal) {
    return (
      <header
        className="h-14 flex items-center justify-between px-4 sm:px-8 relative z-20"
        style={{
          background: 'transparent',
        }}
      >
        <div />
        <div className="flex items-center gap-5 text-[10px] uppercase tracking-[0.25em] text-gray-600 font-futuristic">
          {address && <ConnectWallet variant="compact" />}
          <div className="flex items-center gap-2.5">
            <div className="relative">
              <motion.div
                className="w-2 h-2 rounded-full"
                animate={isLive ? {
                  boxShadow: ['0 0 6px rgba(16,185,129,0.4)', '0 0 16px rgba(16,185,129,0.8)', '0 0 6px rgba(16,185,129,0.4)'],
                } : {}}
                transition={{ repeat: Infinity, duration: 2 }}
                style={{
                  background: isLive ? '#10b981' : '#6b7280',
                }}
              />
            </div>
            <span>{isLive ? 'Live' : 'Standby'}</span>
          </div>
          <span className="font-mono tabular-nums text-gray-600">
            {clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        </div>
      </header>
    )
  }

  const cash = portfolio?.cash ?? 0
  const totalValue = portfolio?.totalValue ?? cash
  const pnl = portfolio?.pnl?.total ?? 0

  return (
    <header
      className="h-14 flex items-center justify-between px-4 sm:px-8 relative z-20"
      style={{
        background: 'rgba(10, 10, 18, 0.6)',
        backdropFilter: 'blur(40px) saturate(1.4)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
      }}
    >
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent/8 to-transparent" />
      <div className="absolute bottom-0 left-0 right-0 h-6 pointer-events-none" style={{ background: 'linear-gradient(180deg, transparent, rgba(0,212,255,0.01))' }} />

      <Link to="/" className="text-[11px] sm:text-[13px] uppercase tracking-[0.16em] sm:tracking-[0.22em] text-gray-500 hover:text-gray-200 transition-colors duration-500 font-futuristic">
        Polymarket Bot
      </Link>

      <div className="flex items-center gap-3 sm:gap-6 text-[10px] uppercase tracking-[0.2em] text-gray-500 font-futuristic">
        {/* Notification toggle */}
        <button
          onClick={notifications.toggle}
          className="relative group p-1.5 rounded-lg transition-colors duration-300 hover:bg-white/5"
          title={notifications.enabled ? 'Notifications on' : 'Notifications off'}
        >
          {notifications.enabled ? (
            <Bell size={14} className="text-gray-400 group-hover:text-accent transition-colors" />
          ) : (
            <BellOff size={14} className="text-gray-600 group-hover:text-gray-400 transition-colors" />
          )}
          {notifications.enabled && (
            <motion.div
              className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full"
              style={{ background: '#00d4ff' }}
              animate={{ opacity: [1, 0.4, 1] }}
              transition={{ repeat: Infinity, duration: 2 }}
            />
          )}
        </button>

        <div className="hidden sm:block w-px h-4" style={{ background: 'rgba(255,255,255,0.06)' }} />

        {address && (
          <>
            <ConnectWallet variant="compact" />
            <div className="hidden sm:block w-px h-4" style={{ background: 'rgba(255,255,255,0.06)' }} />
          </>
        )}
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <motion.div
              className="w-2 h-2 rounded-full"
              animate={isLive ? {
                boxShadow: ['0 0 6px rgba(16,185,129,0.5)', '0 0 14px rgba(16,185,129,0.8)', '0 0 6px rgba(16,185,129,0.5)'],
              } : {}}
              transition={{ repeat: Infinity, duration: 2 }}
              style={{
                background: isLive ? '#10b981' : '#6b7280',
              }}
            />
          </div>
          <span>{isLive ? 'Live' : 'Standby'}</span>
        </div>

        <div className="hidden sm:block w-px h-4" style={{ background: 'rgba(255,255,255,0.06)' }} />

        <span className="font-mono tabular-nums text-gray-500 text-xs sm:text-sm">
          {clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>

        <div className="hidden sm:block w-px h-4" style={{ background: 'rgba(255,255,255,0.06)' }} />

        {!loading && (
          <span className="hidden sm:inline font-mono text-gray-400 text-sm">
            ${totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
        )}

        {!loading && pnl !== 0 && (
          <>
            <div className="hidden sm:block w-px h-4" style={{ background: 'rgba(255,255,255,0.06)' }} />
            <span className={`font-mono text-xs sm:text-sm font-medium ${pnl >= 0 ? 'profit-glow' : 'loss-glow'}`}>
              {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
            </span>
          </>
        )}
      </div>
    </header>
  )
}
