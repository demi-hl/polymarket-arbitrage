import React, { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { StaggerContainer, StaggerItem } from '../components/PageTransition'
import { Activity, TrendingUp, TrendingDown, Clock, Brain, ExternalLink } from '../components/Icons'

function Skeleton({ className = '' }) {
  return <div className={`shimmer rounded-2xl bg-trader-700/50 ${className}`} />
}

function useOracleStatus() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/oracle/status')
        const json = await res.json()
        if (json.success) setData(json.data)
      } catch {} finally { setLoading(false) }
    }
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])
  return { data, loading }
}

function useTheses() {
  const [theses, setTheses] = useState([])
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/oracle/theses')
        const json = await res.json()
        if (json.success) setTheses(json.data?.theses || json.data || [])
      } catch {}
    }
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])
  return theses
}

function useOracleSignals() {
  const [signals, setSignals] = useState({ whales: [], xSentiment: [] })
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/oracle/signals')
        const json = await res.json()
        if (json.success) setSignals(json.data)
      } catch {}
    }
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])
  return signals
}

function timeAgo(ts) {
  if (!ts) return '—'
  const diff = Date.now() - ts
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

function timeLeft(ts) {
  if (!ts) return '—'
  const diff = ts - Date.now()
  if (diff <= 0) return 'expired'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m left`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h left`
  return `${Math.floor(diff / 86400000)}d left`
}

const BIAS_COLORS = {
  bullish: { bg: 'rgba(16,185,129,0.08)', border: 'rgba(16,185,129,0.15)', text: '#10b981' },
  bearish: { bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.15)', text: '#ef4444' },
  'bearish-crypto': { bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.15)', text: '#ef4444' },
  'bullish-crypto': { bg: 'rgba(16,185,129,0.08)', border: 'rgba(16,185,129,0.15)', text: '#10b981' },
  contrarian: { bg: 'rgba(168,85,247,0.08)', border: 'rgba(168,85,247,0.15)', text: '#a855f7' },
  'contrarian-bullish': { bg: 'rgba(168,85,247,0.08)', border: 'rgba(168,85,247,0.15)', text: '#a855f7' },
  mixed: { bg: 'rgba(107,114,128,0.08)', border: 'rgba(107,114,128,0.15)', text: '#6b7280' },
}

const SOURCE_LABELS = {
  'oracle-news-scanner': 'News',
  'oracle-whale-tracker': 'Whale',
  'oracle-x-sentiment': 'X/Twitter',
  manual: 'Manual',
}

function ThesisCard({ thesis }) {
  const colors = BIAS_COLORS[thesis.bias] || BIAS_COLORS.mixed
  const conf = ((thesis.confidence || 0) * 100).toFixed(0)
  const sourceLabel = SOURCE_LABELS[thesis.source] || thesis.source || 'Auto'

  return (
    <StaggerItem>
      <div className="rounded-xl border p-4 transition-all duration-300 hover:border-white/[0.12]"
        style={{
          background: colors.bg,
          borderColor: colors.border,
        }}
      >
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wider px-2 py-0.5 rounded-md"
              style={{ background: colors.bg, color: colors.text, border: `1px solid ${colors.border}` }}
            >
              {thesis.bias || 'neutral'}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-gray-600 px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              {sourceLabel}
            </span>
          </div>
          <span className="font-mono text-xs" style={{ color: colors.text }}>{conf}%</span>
        </div>

        <h4 className="text-sm text-white font-medium mb-1">
          {thesis.id || thesis.title || 'Untitled Thesis'}
        </h4>

        {thesis.notes && (
          <p className="text-xs text-gray-500 leading-relaxed mb-2 line-clamp-2">
            {thesis.notes}
          </p>
        )}

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {thesis.direction && (
              <span className={`text-[10px] font-medium uppercase ${
                thesis.direction.includes('YES') ? 'text-emerald-400' : thesis.direction.includes('NO') ? 'text-red-400' : 'text-gray-500'
              }`}>
                {thesis.direction}
              </span>
            )}
            {thesis.keywords?.length > 0 && (
              <span className="text-[10px] text-gray-600">
                {thesis.keywords.slice(0, 3).join(', ')}
              </span>
            )}
          </div>
          <span className="text-[10px] text-gray-600">
            {thesis.expiresAt ? timeLeft(thesis.expiresAt) : timeAgo(thesis.createdAt)}
          </span>
        </div>
      </div>
    </StaggerItem>
  )
}

function XSentimentCard({ signal }) {
  const sentiment = signal.sentiment || 'mixed'
  const isBullish = sentiment === 'bullish'
  const isBearish = sentiment === 'bearish'
  const conf = ((signal.confidence || 0) * 100).toFixed(0)

  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-white/[0.03] last:border-0">
      <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{
          background: isBullish ? 'rgba(16,185,129,0.1)' : isBearish ? 'rgba(239,68,68,0.1)' : 'rgba(107,114,128,0.1)',
          border: `1px solid ${isBullish ? 'rgba(16,185,129,0.2)' : isBearish ? 'rgba(239,68,68,0.2)' : 'rgba(107,114,128,0.2)'}`,
        }}
      >
        {isBullish ? <TrendingUp size={13} className="text-emerald-400" /> : isBearish ? <TrendingDown size={13} className="text-red-400" /> : <Activity size={13} className="text-gray-500" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-300">{signal.queryId || signal.query}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] text-gray-600">{signal.category}</span>
          {signal.isTrending && (
            <span className="text-[10px] text-accent uppercase">trending</span>
          )}
          <span className="text-[10px] text-gray-600">{signal.sampleSize || 0} posts</span>
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        <span className={`text-xs font-medium ${isBullish ? 'text-emerald-400' : isBearish ? 'text-red-400' : 'text-gray-500'}`}>
          {sentiment} ({conf}%)
        </span>
        <p className="text-[10px] text-gray-600 mt-0.5">{timeAgo(signal.timestamp)}</p>
      </div>
    </div>
  )
}

function WhaleSignalCard({ signal }) {
  const direction = signal.direction || signal.side || 'UNKNOWN'
  const isBullish = direction === 'BUY' || direction === 'BUY_YES' || direction === 'buy'

  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-white/[0.03] last:border-0">
      <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{
          background: 'rgba(168,85,247,0.1)',
          border: '1px solid rgba(168,85,247,0.2)',
        }}
      >
        <Activity size={13} className="text-purple-400" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-300 truncate">{signal.title || signal.username || signal.marketId?.slice(0, 16) || '—'}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] uppercase tracking-wider text-gray-600">
            {signal.type === 'whale-flow' ? 'Flow' : signal.type === 'smart-wallet' ? 'Smart $' : signal.type}
          </span>
          <span className="text-[10px] text-gray-600">
            ${(signal.totalSize || signal.size || 0).toLocaleString()}
          </span>
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        <span className={`text-xs font-medium ${isBullish ? 'text-emerald-400' : 'text-red-400'}`}>
          {direction}
        </span>
        <p className="text-[10px] text-gray-600 mt-0.5">{timeAgo(signal.timestamp)}</p>
      </div>
    </div>
  )
}

export default function NewsScanner() {
  const { data: oracle, loading } = useOracleStatus()
  const theses = useTheses()
  const signals = useOracleSignals()
  const [filterSource, setFilterSource] = useState('all')

  const filteredTheses = filterSource === 'all'
    ? theses
    : theses.filter(t => t.source === filterSource)

  const activeTheses = filteredTheses.filter(t => !t.expiresAt || t.expiresAt > Date.now())
  const expiredTheses = filteredTheses.filter(t => t.expiresAt && t.expiresAt <= Date.now())

  const sources = ['all', ...new Set(theses.map(t => t.source).filter(Boolean))]

  if (loading) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-12 w-80" />
        <div className="grid grid-cols-4 gap-5">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
        <Skeleton className="h-[500px]" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-gradient-minimal">News & Sentiment Scanner</h2>
          <p className="text-xs text-gray-500 mt-1">
            Oracle daemon · News + X/Twitter + Whale signals · Auto-thesis generation
          </p>
        </div>
        {oracle?.stats?.lastRun && (
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" style={{ boxShadow: '0 0 6px rgba(16,185,129,0.5)' }} />
            <span className="text-xs text-gray-500">Last scan: {timeAgo(oracle.stats.lastRun)}</span>
          </div>
        )}
      </div>

      {/* Stats Row */}
      <StaggerContainer className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StaggerItem>
          <div className="rounded-xl border p-4 border-white/[0.06]" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <p className="text-[10px] uppercase tracking-[0.15em] text-gray-600 mb-1">Active Theses</p>
            <p className="font-mono text-xl text-white">{oracle?.activeTheses || activeTheses.length}</p>
          </div>
        </StaggerItem>
        <StaggerItem>
          <div className="rounded-xl border p-4 border-white/[0.06]" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <p className="text-[10px] uppercase tracking-[0.15em] text-gray-600 mb-1">Whale Signals</p>
            <p className="font-mono text-xl text-purple-400">{oracle?.recentWhaleSignals || signals.whales?.length || 0}</p>
          </div>
        </StaggerItem>
        <StaggerItem>
          <div className="rounded-xl border p-4 border-white/[0.06]" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <p className="text-[10px] uppercase tracking-[0.15em] text-gray-600 mb-1">X Sentiment</p>
            <p className="font-mono text-xl text-accent">{signals.xSentiment?.length || 0}</p>
          </div>
        </StaggerItem>
        <StaggerItem>
          <div className="rounded-xl border p-4 border-white/[0.06]" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <p className="text-[10px] uppercase tracking-[0.15em] text-gray-600 mb-1">Scan Cycles</p>
            <p className="font-mono text-xl text-gray-400">{oracle?.stats?.totalRuns || 0}</p>
          </div>
        </StaggerItem>
      </StaggerContainer>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Theses — main panel */}
        <div className="lg:col-span-2 space-y-4">
          {/* Source filter */}
          <div className="flex items-center gap-2 flex-wrap">
            {sources.map(src => (
              <button
                key={src}
                onClick={() => setFilterSource(src)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  filterSource === src
                    ? 'text-white bg-white/[0.08]'
                    : 'text-gray-500 hover:text-gray-300 bg-white/[0.02]'
                }`}
              >
                {src === 'all' ? 'All Sources' : SOURCE_LABELS[src] || src}
              </button>
            ))}
          </div>

          {/* Active Theses */}
          {activeTheses.length > 0 ? (
            <StaggerContainer className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {activeTheses.map((t, i) => <ThesisCard key={t.id || i} thesis={t} />)}
            </StaggerContainer>
          ) : (
            <div className="rounded-xl border border-white/[0.06] p-8 text-center" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <Brain size={32} className="text-gray-600 mx-auto mb-3" />
              <p className="text-gray-500 text-sm">No active theses</p>
              <p className="text-gray-600 text-xs mt-1">
                Oracle daemon auto-generates theses from news, X, and whale signals every 10 minutes
              </p>
            </div>
          )}

          {/* Expired Theses */}
          {expiredTheses.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-gray-600 mb-3">Recently Expired</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 opacity-50">
                {expiredTheses.slice(0, 4).map((t, i) => (
                  <div key={t.id || i} className="rounded-xl border border-white/[0.04] p-3" style={{ background: 'rgba(255,255,255,0.01)' }}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-600">{t.id || t.title}</span>
                      <span className="text-[10px] text-gray-700">{t.bias}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right sidebar — signals */}
        <div className="space-y-5">
          {/* X Sentiment Feed */}
          <div className="rounded-xl border border-white/[0.06] p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <h3 className="text-sm font-medium text-gray-300 mb-3">X/Twitter Sentiment</h3>
            {signals.xSentiment?.length > 0 ? (
              <div className="space-y-0">
                {signals.xSentiment.slice(0, 10).map((sig, i) => (
                  <XSentimentCard key={sig.timestamp + '-' + i} signal={sig} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-600 text-center py-6">No X sentiment signals in the last hour</p>
            )}
          </div>

          {/* Whale Signals */}
          <div className="rounded-xl border border-white/[0.06] p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
            <h3 className="text-sm font-medium text-gray-300 mb-3">Whale Signals</h3>
            {signals.whales?.length > 0 ? (
              <div className="space-y-0">
                {signals.whales.slice(0, 10).map((sig, i) => (
                  <WhaleSignalCard key={sig.timestamp + '-' + i} signal={sig} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-600 text-center py-6">No whale signals in the last hour</p>
            )}
          </div>

          {/* Oracle Stats */}
          {oracle?.stats && (
            <div className="rounded-xl border border-white/[0.06] p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <h3 className="text-sm font-medium text-gray-300 mb-3">Oracle Stats</h3>
              <div className="space-y-2.5">
                <div className="flex justify-between">
                  <span className="text-xs text-gray-600">Total Runs</span>
                  <span className="text-xs font-mono text-gray-400">{oracle.stats.totalRuns}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-xs text-gray-600">Total Signals</span>
                  <span className="text-xs font-mono text-accent">{oracle.stats.totalSignals}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-xs text-gray-600">Total Theses</span>
                  <span className="text-xs font-mono text-purple-400">{oracle.stats.totalTheses}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-xs text-gray-600">Last Run</span>
                  <span className="text-xs font-mono text-gray-400">{timeAgo(oracle.stats.lastRun)}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
