import React from 'react'
import { motion } from 'framer-motion'
import { useWallet } from '../context/WalletContext'

function truncAddr(addr) {
  if (!addr) return ''
  return addr.slice(0, 6) + '...' + addr.slice(-4)
}

export default function ConnectWallet({ variant = 'default' }) {
  const { address, isConnecting, checking, nftVerified, nftBalance, connect, disconnect } = useWallet()

  if (!address) {
    return (
      <button
        onClick={connect}
        disabled={isConnecting}
        className="group relative overflow-hidden rounded-xl text-sm font-medium tracking-wide transition-all duration-500"
        style={{ padding: variant === 'compact' ? '8px 20px' : '14px 36px' }}
      >
        <div
          className="absolute inset-0 rounded-xl transition-all duration-500"
          style={{
            background: 'rgba(168, 85, 247, 0.08)',
            border: '1px solid rgba(168, 85, 247, 0.2)',
          }}
        />
        <div
          className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-all duration-500"
          style={{
            background: 'linear-gradient(135deg, rgba(168,85,247,0.15) 0%, rgba(0,212,255,0.08) 100%)',
            border: '1px solid rgba(168,85,247,0.4)',
            boxShadow: '0 0 40px rgba(168, 85, 247, 0.15)',
          }}
        />
        <span className="relative z-10 text-gray-300 group-hover:text-white transition-colors duration-300">
          {isConnecting ? 'Connecting...' : 'Connect Wallet'}
        </span>
      </button>
    )
  }

  // Connected state
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2.5">
        {/* NFT status indicator */}
        <motion.div
          className="w-2 h-2 rounded-full"
          animate={nftVerified ? {
            boxShadow: ['0 0 4px rgba(168,85,247,0.4)', '0 0 14px rgba(168,85,247,0.8)', '0 0 4px rgba(168,85,247,0.4)'],
          } : {}}
          transition={{ repeat: Infinity, duration: 2 }}
          style={{
            background: checking
              ? '#f59e0b'
              : nftVerified
                ? '#a855f7'
                : '#ef4444',
          }}
        />

        <div className="flex flex-col">
          <span className="font-mono text-sm text-gray-400 tabular-nums">
            {truncAddr(address)}
          </span>
          <span className="text-xs uppercase tracking-[0.15em]" style={{
            color: checking ? '#f59e0b' : nftVerified ? '#a855f7' : '#ef4444',
          }}>
            {checking ? 'Verifying...' : nftVerified ? `Locals Only · ${nftBalance}` : 'No Locals Only NFT'}
          </span>
        </div>
      </div>

      {variant !== 'compact' && (
        <button
          onClick={disconnect}
          className="text-xs uppercase tracking-[0.15em] text-gray-600 hover:text-gray-400 transition-colors duration-300 ml-2"
        >
          Disconnect
        </button>
      )}
    </div>
  )
}
