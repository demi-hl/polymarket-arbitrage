import React from 'react'
import { motion } from 'framer-motion'
import { useWallet } from '../context/WalletContext'
import ConnectWallet from './ConnectWallet'

export default function NFTGate({ children }) {
  const { address, nftVerified, checking } = useWallet()

  // Not connected — show connect prompt
  if (!address) {
    return (
      <div className="min-h-full flex flex-col items-center justify-center px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="text-center max-w-md"
        >
          <div className="mb-6">
            <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center"
              style={{
                background: 'rgba(168, 85, 247, 0.1)',
                border: '1px solid rgba(168, 85, 247, 0.2)',
              }}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#a855f7" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <h2 className="text-xl font-light text-white mb-2">NFT Access Required</h2>
            <p className="text-sm text-gray-500 leading-relaxed">
              Connect your wallet to verify you hold a Locals Only NFT on HyperEVM.
            </p>
          </div>
          <ConnectWallet />
        </motion.div>
      </div>
    )
  }

  // Connected but checking NFT
  if (checking || nftVerified === null) {
    return (
      <div className="min-h-full flex flex-col items-center justify-center px-6">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-center"
        >
          <motion.div
            className="w-8 h-8 rounded-full mx-auto mb-4"
            style={{ border: '2px solid rgba(168, 85, 247, 0.3)', borderTopColor: '#a855f7' }}
            animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
          />
          <p className="text-sm text-gray-500">Verifying NFT ownership...</p>
        </motion.div>
      </div>
    )
  }

  // Connected but no NFT
  if (!nftVerified) {
    return (
      <div className="min-h-full flex flex-col items-center justify-center px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="text-center max-w-md"
        >
          <div className="mb-6">
            <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center"
              style={{
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.2)',
              }}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            </div>
            <h2 className="text-xl font-light text-white mb-2">Access Denied</h2>
            <p className="text-sm text-gray-500 leading-relaxed mb-4">
              No Locals Only NFT found in this wallet. You need to hold at least one on HyperEVM to access the dashboard.
            </p>
            <ConnectWallet variant="compact" />
          </div>
        </motion.div>
      </div>
    )
  }

  // Verified — render dashboard
  return children
}
