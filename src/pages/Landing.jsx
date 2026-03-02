import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useMultiAccount } from '../context/MultiAccountContext'

export default function Landing() {
  const [clock, setClock] = useState(new Date())
  const { accountIds, comparison, accounts } = useMultiAccount()

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const acctValues = Object.values(accounts || {})
  const combined = comparison?.combinedValue
    ? parseFloat(comparison.combinedValue)
    : acctValues.reduce((sum, acct) => sum + (acct?.totalValue || 0), 0)
  const totalCash = acctValues.reduce((sum, acct) => sum + (acct?.cash || 0), 0)
  const totalTrades = acctValues.reduce((sum, acct) => sum + (acct?.totalTrades || 0), 0)
  const totalOpen = acctValues.reduce((sum, acct) => sum + (acct?.openTradeCount || acct?.openPositions || 0), 0)
  const live = accountIds.length >= 1
  const displayValue = typeof totalCash === 'number' && totalCash > 0 ? totalCash : (typeof combined === 'number' ? combined : 0)

  const stagger = {
    container: { animate: { transition: { staggerChildren: 0.1 } } },
    item: { initial: { opacity: 0, y: 20 }, animate: { opacity: 1, y: 0 } },
  }

  return (
    <div className="min-h-full flex flex-col items-center justify-center font-futuristic relative">
      <motion.div
        className="relative z-10 w-full max-w-2xl mx-auto text-center px-6"
        variants={stagger.container}
        initial="initial"
        animate="animate"
      >
        <motion.p
          variants={stagger.item}
          transition={{ duration: 0.6 }}
          className="text-[11px] uppercase tracking-[0.25em] text-gray-500 mb-6"
        >
          Polymarket Arbitrage System
        </motion.p>

        <motion.h1
          variants={stagger.item}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="text-5xl sm:text-6xl font-light tracking-tight text-white mb-2 leading-[0.95]"
        >
          A Locals Only
        </motion.h1>
        <motion.h2
          variants={stagger.item}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="text-5xl sm:text-6xl font-light tracking-tight mb-8 leading-[0.95] text-gradient-minimal"
        >
          Production
        </motion.h2>

        <motion.p
          variants={stagger.item}
          transition={{ duration: 0.6 }}
          className="text-sm text-gray-500 font-light tracking-wide max-w-lg mx-auto leading-relaxed mb-2"
        >
          17 strategies. ML edge scoring. Whale tracking. News sentiment. Technical analysis.
        </motion.p>
        <motion.p
          variants={stagger.item}
          transition={{ duration: 0.5 }}
          className="text-[10px] text-gray-600 tracking-[0.2em] uppercase mb-10"
        >
          by DEMI
        </motion.p>

        <motion.div
          variants={stagger.item}
          transition={{ duration: 0.5 }}
          className="flex items-center justify-center gap-4 mb-12"
        >
          <Link
            to="/paper"
            className="group relative overflow-hidden rounded-xl text-sm font-medium tracking-wide transition-all duration-400"
            style={{ padding: '14px 36px' }}
          >
            <div className="absolute inset-0 rounded-xl"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
            />
            <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-400"
              style={{ background: 'linear-gradient(135deg, rgba(0,212,255,0.08) 0%, rgba(168,85,247,0.04) 100%)', border: '1px solid rgba(0,212,255,0.2)' }}
            />
            <span className="relative z-10 text-white">Enter Dashboard</span>
          </Link>
          <Link to="/overview" className="text-sm text-gray-500 hover:text-white transition-colors" style={{ padding: '14px 24px' }}>
            Overview
          </Link>
        </motion.div>

        <motion.div
          variants={stagger.item}
          transition={{ duration: 0.6 }}
          className="flex flex-wrap items-center justify-center gap-6 text-[11px] uppercase tracking-widest text-gray-600"
        >
          <div className="flex items-center gap-2">
            <motion.div
              className="w-1.5 h-1.5 rounded-full"
              animate={{ boxShadow: live ? ['0 0 4px rgba(16,185,129,0.3)', '0 0 12px rgba(16,185,129,0.6)', '0 0 4px rgba(16,185,129,0.3)'] : 'none' }}
              transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
              style={{ background: live ? '#10b981' : '#4b5563' }}
            />
            {live ? 'Live' : 'Standby'}
          </div>
          <span className="font-mono tabular-nums text-gray-500">
            {clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
          <span className="font-mono text-gray-500">
            ${displayValue > 0 ? Math.round(displayValue).toLocaleString() : '—'}
          </span>
          {totalTrades > 0 && (
            <span className="font-mono text-gray-600 text-[10px]">
              {totalTrades} trades &middot; {totalOpen} open
            </span>
          )}
        </motion.div>
      </motion.div>
    </div>
  )
}
