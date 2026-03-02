import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useTrading } from '../context/TradingContext'
import { useMultiAccount } from '../context/MultiAccountContext'

export default function Header({ minimal = false }) {
  const [clock, setClock] = useState(new Date())
  const { portfolio } = useTrading()
  const { accountIds, loading } = useMultiAccount()

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const isLive = !loading && accountIds.length >= 1

  if (minimal) {
    return (
      <header
        className="h-14 flex items-center justify-end px-8 relative z-20"
        style={{
          background: 'transparent',
          borderBottom: '1px solid rgba(255,255,255,0.03)',
        }}
      >
        <div className="flex items-center gap-5 text-xs uppercase tracking-widest text-gray-500 font-futuristic">
          <div className="flex items-center gap-2.5">
            <div
              className="w-2 h-2 rounded-full"
              style={{
                background: isLive ? '#10b981' : '#6b7280',
                boxShadow: isLive ? '0 0 8px rgba(16,185,129,0.5)' : 'none',
              }}
            />
            <span>{isLive ? 'Live' : 'Standby'}</span>
          </div>
          <span className="font-mono tabular-nums text-gray-600">
            {clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        </div>
      </header>
    )
  }

  return (
    <header
      className="h-14 flex items-center justify-between px-8 relative z-20"
      style={{
        background: 'rgba(18, 18, 26, 0.4)',
        backdropFilter: 'blur(16px)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.03)',
      }}
    >
      <Link to="/" className="text-sm uppercase tracking-[0.2em] text-gray-500 hover:text-gray-300 transition-colors font-futuristic">
        Polymarket Bot
      </Link>
      <div className="flex items-center gap-6 text-xs uppercase tracking-widest text-gray-500 font-futuristic">
        <div className="flex items-center gap-2.5">
          <div
            className="w-2 h-2 rounded-full"
            style={{
              background: isLive ? '#10b981' : '#6b7280',
              boxShadow: isLive ? '0 0 8px rgba(16,185,129,0.5)' : 'none',
            }}
          />
          <span>{isLive ? 'Live' : 'Standby'}</span>
        </div>
        <div className="w-px h-4" style={{ background: 'rgba(255,255,255,0.06)' }} />
        <span className="font-mono tabular-nums text-gray-600 text-sm">
          {clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
        <div className="w-px h-4" style={{ background: 'rgba(255,255,255,0.06)' }} />
        <span className="font-mono text-gray-500 text-sm">
          ${(portfolio?.cash ?? 0).toLocaleString()}
        </span>
      </div>
    </header>
  )
}
