import React, { useRef, useEffect, useState } from 'react'

export default function LiveTradeFeed({ trades = [], maxItems = 25 }) {
  const containerRef = useRef(null)
  const [prevCount, setPrevCount] = useState(trades.length)
  const newCount = Math.max(0, trades.length - prevCount)

  useEffect(() => {
    if (containerRef.current && trades.length > prevCount) containerRef.current.scrollTop = 0
    const t = setTimeout(() => setPrevCount(trades.length), 1500)
    return () => clearTimeout(t)
  }, [trades.length, prevCount])

  return (
    <div className="h-full flex flex-col border border-white/[0.04] rounded-lg py-5 px-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{
              background: trades.length > 0 ? '#10b981' : '#6b7280',
              boxShadow: trades.length > 0 ? '0 0 6px rgba(16,185,129,0.4)' : 'none',
            }}
          />
          <p className="text-[11px] uppercase tracking-[0.2em] text-gray-500">Live feed <span className="text-gray-600 font-normal">(paper)</span></p>
        </div>
        {newCount > 0 && (
          <span className="text-[10px] font-mono text-profit">+{newCount}</span>
        )}
      </div>

      {trades.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-10">
          <div className="w-8 h-8 rounded-full border border-white/[0.06] flex items-center justify-center mb-3">
            <div className="w-3 h-3 rounded-full border border-white/[0.1]" />
          </div>
          <p className="text-xs text-gray-500">Waiting for paper trades</p>
          <p className="text-[10px] text-gray-600 mt-0.5">Bots are paper-only · A & B scan every 90s</p>
        </div>
      ) : (
        <div ref={containerRef} className="flex-1 overflow-y-auto -mx-1" style={{ maxHeight: '320px' }}>
          {trades.slice(0, maxItems).map((trade, i) => (
            <TradeRow key={trade.id || `${trade.timestamp}-${i}`} trade={trade} isNew={i < newCount} />
          ))}
        </div>
      )}
    </div>
  )
}

function TradeRow({ trade, isNew }) {
  const isA = trade.accountId === 'A'
  const hasRealized = trade.realizedPnl != null
  const profit = hasRealized ? trade.realizedPnl : (trade.expectedProfit || 0)
  const edge = trade.edgePercent ? (trade.edgePercent * 100).toFixed(1) : '0.0'
  const time = trade.timestamp ? new Date(trade.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''
  const color = isA ? '#f59e0b' : '#00d4ff'
  const isClosed = hasRealized || trade.status === 'closed'

  return (
    <div className={`py-3 border-b border-white/[0.03] last:border-b-0 ${isNew ? 'bg-white/[0.02] -mx-2 px-2 rounded' : ''}`}>
      <div className="flex items-start gap-3">
        <span className="text-[10px] font-medium w-5 flex-shrink-0" style={{ color }}>{trade.accountId || '?'}</span>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-gray-300 truncate">{trade.question || 'Unknown'}</p>
          <p className="text-[10px] font-mono text-gray-500 mt-0.5">
            {time} · {edge}% edge
            {isClosed && <span className="text-gray-600"> · closed</span>}
          </p>
        </div>
        <div className="text-right flex-shrink-0">
          <p className={`text-xs font-mono ${profit >= 0 ? 'text-profit' : 'text-loss'}`}>
            {profit >= 0 ? '+' : ''}{profit.toFixed(2)}
          </p>
          <p className="text-[10px] font-mono text-gray-600">${(trade.totalCost || 0).toFixed(0)}</p>
        </div>
      </div>
    </div>
  )
}
