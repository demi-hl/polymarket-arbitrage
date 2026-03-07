import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useMultiAccount } from '../context/MultiAccountContext'
import { useWallet } from '../context/WalletContext'
import DarkOrb from '../components/DarkOrb'
import ConnectWallet from '../components/ConnectWallet'

const ease = [0.16, 1, 0.3, 1]

function StatPill({ value, label, color = '#00d4ff', delay = 0, icon }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.7, delay, ease }}
      className="flex items-center gap-2.5 px-4 py-2.5 rounded-2xl relative overflow-hidden group"
      style={{
        background: 'rgba(12, 12, 20, 0.6)',
        backdropFilter: 'blur(20px)',
        border: `1px solid ${color}11`,
        boxShadow: `0 0 20px ${color}06, inset 0 1px 0 rgba(255,255,255,0.03)`,
      }}
    >
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-700" style={{ background: `radial-gradient(circle at center, ${color}08, transparent 70%)` }} />
      {icon && <span className="text-xs" style={{ color: `${color}99` }}>{icon}</span>}
      <div className="flex flex-col items-start gap-0.5 relative z-10">
        <span className="font-mono text-base tabular-nums tracking-tight font-medium" style={{ color }}>{value}</span>
        <span className="text-[9px] uppercase tracking-[0.25em] text-gray-600 font-medium">{label}</span>
      </div>
    </motion.div>
  )
}

export default function Landing() {
  const [clock, setClock] = useState(new Date())
  const { accountIds, accounts } = useMultiAccount()
  const { address, nftVerified } = useWallet()

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const acctValues = Object.values(accounts || {})
  const totalTrades = acctValues.reduce((sum, acct) => sum + (acct?.totalTrades || 0), 0)
  const totalOpen = acctValues.reduce((sum, acct) => sum + (acct?.openTradeCount || acct?.openPositions || 0), 0)
  const totalPnl = acctValues.reduce((sum, acct) => {
    const pnl = acct?.pnl || {}
    return sum + (pnl.total || pnl.realized || 0)
  }, 0)
  const totalEquity = acctValues.reduce((sum, acct) => {
    const val = acct?.totalValue ?? acct?.cash ?? 0
    return sum + val
  }, 0)
  const live = accountIds.length >= 1

  const stagger = {
    container: { animate: { transition: { staggerChildren: 0.1 } } },
    item: { initial: { opacity: 0, y: 40, filter: 'blur(12px)' }, animate: { opacity: 1, y: 0, filter: 'blur(0px)' } },
  }

  return (
    <div className="min-h-full flex flex-col items-center justify-center font-futuristic relative overflow-hidden -mx-4 sm:-mx-6 lg:-mx-8 -my-4 sm:-my-6 px-4 sm:px-6 lg:px-8 py-4 sm:py-6" style={{ minHeight: 'calc(100vh - 3.5rem)' }}>
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
          className="mb-6"
        >
          <span className="inline-flex items-center gap-3 text-xs uppercase tracking-[0.35em] text-gray-500">
            <span className="w-12 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
            Polymarket Arbitrage Engine
            <span className="w-12 h-px bg-gradient-to-l from-transparent via-accent/30 to-transparent" />
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
          className="text-6xl sm:text-8xl font-extralight tracking-[-0.03em] mb-5 leading-[0.88] text-gradient-hero"
        >
          Production
        </motion.h2>

        {/* Tagline — animated reveal */}
        <motion.div
          variants={stagger.item}
          transition={{ duration: 0.7 }}
          className="mb-3 space-y-2"
        >
          <div className="flex items-center justify-center gap-3 flex-wrap">
            {['Latency Engine', 'Elections', 'Sports Odds', 'Weather', 'Copy-Trade', 'Macro Data', 'New Market Alpha'].map((tag, i) => (
              <motion.span
                key={tag}
                initial={{ opacity: 0, scale: 0.8, filter: 'blur(8px)' }}
                animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                transition={{ delay: 1.2 + i * 0.1, duration: 0.6, ease }}
                className="text-[11px] uppercase tracking-[0.15em] px-3 py-1.5 rounded-full font-medium"
                style={{
                  background: 'rgba(0,212,255,0.06)',
                  border: '1px solid rgba(0,212,255,0.1)',
                  color: 'rgba(0,212,255,0.7)',
                }}
              >
                {tag}
              </motion.span>
            ))}
          </div>
          <p className="text-sm text-gray-600 font-light tracking-wide max-w-md mx-auto leading-relaxed">
            37 strategies · MRO-Kelly sizing · Rust execution engine
          </p>
        </motion.div>

        <motion.p
          variants={stagger.item}
          transition={{ duration: 0.5 }}
          className="text-xs text-gray-600 tracking-[0.3em] uppercase mb-8 font-medium"
        >
          by DEMI
        </motion.p>

        {/* Wallet Connect */}
        <motion.div
          variants={stagger.item}
          transition={{ duration: 0.6 }}
          className="flex flex-col items-center gap-4 mb-6"
        >
          {!address && (
            <p className="text-sm text-gray-500 tracking-wide mb-1">
              Connect your wallet to verify you hold a Locals Only NFT
            </p>
          )}
          <ConnectWallet />
          {address && !nftVerified && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-sm text-red-400/80 tracking-wide"
            >
              No Locals Only NFT found in this wallet
            </motion.p>
          )}
        </motion.div>

        {/* CTAs */}
        <motion.div
          variants={stagger.item}
          transition={{ duration: 0.6 }}
          className="flex items-center justify-center gap-5 mb-8"
        >
          <Link
            to={nftVerified ? '/paper' : '#'}
            onClick={e => { if (!nftVerified) e.preventDefault() }}
            className={`group relative overflow-hidden rounded-2xl text-sm font-medium tracking-wide transition-all duration-700 ${!nftVerified ? 'opacity-40 cursor-not-allowed' : ''}`}
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
          <Link
            to={nftVerified ? '/overview' : '#'}
            onClick={e => { if (!nftVerified) e.preventDefault() }}
            className={`text-sm text-gray-500 hover:text-white transition-colors duration-500 ${!nftVerified ? 'opacity-40 cursor-not-allowed' : ''}`}
            style={{ padding: '18px 32px' }}
          >
            Overview
          </Link>
        </motion.div>

        {/* Divider */}
        <motion.div variants={stagger.item} transition={{ duration: 0.7 }}>
          <div className="glow-line mb-6" />
        </motion.div>

        {/* Stats bar — glass pills */}
        <motion.div
          variants={stagger.item}
          transition={{ duration: 0.8 }}
          className="flex items-center justify-center gap-3 flex-wrap mb-6"
        >
          <motion.div
            className="flex items-center gap-2.5 px-4 py-2.5 rounded-2xl"
            style={{
              background: 'rgba(12, 12, 20, 0.6)',
              backdropFilter: 'blur(20px)',
              border: '1px solid rgba(255,255,255,0.04)',
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5, duration: 0.7 }}
          >
            <motion.div
              className="w-2 h-2 rounded-full relative"
              animate={{
                boxShadow: live
                  ? ['0 0 4px rgba(16,185,129,0.4)', '0 0 16px rgba(16,185,129,0.8)', '0 0 4px rgba(16,185,129,0.4)']
                  : 'none'
              }}
              transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
              style={{ background: live ? '#10b981' : '#4b5563' }}
            />
            <span className="text-[10px] uppercase tracking-[0.2em] text-gray-500 font-medium">
              {live ? 'Live' : 'Standby'}
            </span>
            <span className="font-mono text-sm tabular-nums text-gray-500">
              {clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          </motion.div>

          {totalEquity > 0 && (
            <StatPill
              value={`$${Math.round(totalEquity).toLocaleString()}`}
              label="Portfolio"
              color="#00d4ff"
              delay={0.6}
              icon="◆"
            />
          )}

          {totalPnl !== 0 && (
            <StatPill
              value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`}
              label="P&L"
              color={totalPnl >= 0 ? '#10b981' : '#ef4444'}
              delay={0.7}
              icon={totalPnl >= 0 ? '▲' : '▼'}
            />
          )}

          {totalTrades > 0 && (
            <StatPill
              value={totalTrades.toLocaleString()}
              label="Trades"
              color="#a855f7"
              delay={0.75}
              icon="⚡"
            />
          )}

          {totalOpen > 0 && (
            <StatPill
              value={totalOpen}
              label="Open"
              color="#10b981"
              delay={0.8}
              icon="●"
            />
          )}
        </motion.div>
      </motion.div>
    </div>
  )
}
