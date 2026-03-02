import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useMultiAccount } from '../context/MultiAccountContext'
import DarkOrb from '../components/DarkOrb'

const ease = [0.16, 1, 0.3, 1]

function StatRing({ value, label, color = '#00d4ff', delay = 0 }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.9, delay, ease }}
      className="flex flex-col items-center gap-1"
    >
      <span className="font-mono text-lg tabular-nums tracking-tight" style={{ color }}>{value}</span>
      <span className="text-[10px] uppercase tracking-[0.2em] text-gray-600">{label}</span>
    </motion.div>
  )
}

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
    item: { initial: { opacity: 0, y: 40, filter: 'blur(12px)' }, animate: { opacity: 1, y: 0, filter: 'blur(0px)' } },
  }

  return (
    <div className="min-h-full flex flex-col items-center justify-center font-futuristic relative overflow-hidden">
      {/* Aurora background wash */}
      <div className="aurora-bg" />

      {/* Animated dark orb — centerpiece */}
      <motion.div
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 2, ease }}
        className="absolute z-0"
        style={{ top: '50%', left: '50%', transform: 'translate(-50%, -55%)' }}
      >
        <DarkOrb size={480} />
      </motion.div>

      {/* Subtle orb reflections */}
      <div className="hero-orb hero-orb-1" style={{ opacity: 0.4 }} />
      <div className="hero-orb hero-orb-2" style={{ opacity: 0.3 }} />

      <motion.div
        className="relative z-10 w-full max-w-2xl mx-auto text-center px-6"
        variants={stagger.container}
        initial="initial"
        animate="animate"
      >
        {/* System label */}
        <motion.div
          variants={stagger.item}
          transition={{ duration: 0.8 }}
          className="mb-10"
        >
          <span className="inline-flex items-center gap-3 text-[10px] uppercase tracking-[0.35em] text-gray-500">
            <span className="w-8 h-px bg-gradient-to-r from-transparent to-gray-600" />
            Polymarket Arbitrage System
            <span className="w-8 h-px bg-gradient-to-l from-transparent to-gray-600" />
          </span>
        </motion.div>

        {/* Main title — large, light, cinematic */}
        <motion.h1
          variants={stagger.item}
          transition={{ duration: 1.2, ease }}
          className="text-6xl sm:text-8xl font-extralight tracking-[-0.03em] text-white mb-1 leading-[0.88]"
          style={{ textShadow: '0 0 80px rgba(0, 212, 255, 0.08)' }}
        >
          A Locals Only
        </motion.h1>
        <motion.h2
          variants={stagger.item}
          transition={{ duration: 1.2, ease }}
          className="text-6xl sm:text-8xl font-extralight tracking-[-0.03em] mb-8 leading-[0.88] text-gradient-hero"
        >
          Production
        </motion.h2>

        {/* Tagline */}
        <motion.div
          variants={stagger.item}
          transition={{ duration: 0.7 }}
          className="mb-3 space-y-1"
        >
          <p className="text-[13px] text-gray-500 font-light tracking-wide max-w-md mx-auto leading-relaxed">
            20 strategies · Deep learning edge scoring · GPU-powered sentiment
          </p>
          <p className="text-[13px] text-gray-500 font-light tracking-wide max-w-md mx-auto leading-relaxed">
            Whale tracking · UMA oracle frontrunning · Orderbook CNN
          </p>
        </motion.div>

        <motion.p
          variants={stagger.item}
          transition={{ duration: 0.5 }}
          className="text-[9px] text-gray-600 tracking-[0.3em] uppercase mb-14 font-medium"
        >
          by DEMI
        </motion.p>

        {/* CTAs */}
        <motion.div
          variants={stagger.item}
          transition={{ duration: 0.6 }}
          className="flex items-center justify-center gap-5 mb-16"
        >
          <Link
            to="/paper"
            className="group relative overflow-hidden rounded-2xl text-sm font-medium tracking-wide transition-all duration-700"
            style={{ padding: '18px 48px' }}
          >
            <div className="absolute inset-0 rounded-2xl transition-all duration-700"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
            />
            <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-all duration-700"
              style={{
                background: 'linear-gradient(135deg, rgba(0,212,255,0.12) 0%, rgba(168,85,247,0.06) 100%)',
                border: '1px solid rgba(0,212,255,0.3)',
                boxShadow: '0 0 60px rgba(0, 212, 255, 0.12), inset 0 1px 0 rgba(255,255,255,0.1)',
              }}
            />
            <span className="relative z-10 text-white group-hover:text-accent transition-colors duration-500">Enter Dashboard</span>
          </Link>
          <Link to="/overview" className="text-sm text-gray-500 hover:text-white transition-colors duration-500" style={{ padding: '18px 32px' }}>
            Overview
          </Link>
        </motion.div>

        {/* Divider */}
        <motion.div variants={stagger.item} transition={{ duration: 0.7 }}>
          <div className="glow-line mb-10" />
        </motion.div>

        {/* Stats bar */}
        <motion.div
          variants={stagger.item}
          transition={{ duration: 0.8 }}
          className="flex items-center justify-center gap-10 mb-6"
        >
          <div className="flex items-center gap-2.5">
            <motion.div
              className="w-2 h-2 rounded-full relative"
              animate={{
                boxShadow: live
                  ? ['0 0 4px rgba(16,185,129,0.4)', '0 0 20px rgba(16,185,129,0.8)', '0 0 4px rgba(16,185,129,0.4)']
                  : 'none'
              }}
              transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
              style={{ background: live ? '#10b981' : '#4b5563' }}
            />
            <span className="text-[11px] uppercase tracking-[0.2em] text-gray-600">
              {live ? 'Live' : 'Standby'}
            </span>
          </div>

          <StatRing
            value={clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            label="Local"
            color="#6b7280"
            delay={0.5}
          />

          {displayValue > 0 && (
            <StatRing
              value={`$${Math.round(displayValue).toLocaleString()}`}
              label="Portfolio"
              color="#00d4ff"
              delay={0.6}
            />
          )}

          {totalTrades > 0 && (
            <StatRing
              value={totalTrades}
              label="Trades"
              color="#a855f7"
              delay={0.7}
            />
          )}

          {totalOpen > 0 && (
            <StatRing
              value={totalOpen}
              label="Open"
              color="#10b981"
              delay={0.8}
            />
          )}
        </motion.div>
      </motion.div>
    </div>
  )
}
