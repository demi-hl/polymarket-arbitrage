import React, { useMemo } from 'react'
import { motion } from 'framer-motion'

/**
 * Calculate EMA (Exponential Moving Average)
 */
function calcEMA(data, period) {
  if (data.length < period) return data.map(() => null)
  const k = 2 / (period + 1)
  const ema = new Array(data.length).fill(null)
  // SMA seed
  let sum = 0
  for (let i = 0; i < period; i++) sum += data[i]
  ema[period - 1] = sum / period
  for (let i = period; i < data.length; i++) {
    ema[i] = data[i] * k + ema[i - 1] * (1 - k)
  }
  return ema
}

/**
 * Find support/resistance levels from local min/max
 */
function findSupportResistance(prices, lookback = 5) {
  const levels = []
  for (let i = lookback; i < prices.length - lookback; i++) {
    const window = prices.slice(i - lookback, i + lookback + 1)
    const price = prices[i]
    if (price === Math.max(...window)) {
      levels.push({ price, type: 'resistance', index: i })
    }
    if (price === Math.min(...window)) {
      levels.push({ price, type: 'support', index: i })
    }
  }
  // Deduplicate close levels (within 2%)
  const merged = []
  for (const level of levels) {
    const existing = merged.find(l => l.type === level.type && Math.abs(l.price - level.price) / level.price < 0.02)
    if (!existing) merged.push(level)
  }
  return merged.slice(-6) // Last 6 levels
}

/**
 * SVG-based Technical Analysis Chart
 */
export default function TAChart({
  priceHistory = [],
  volumes = [],
  width = 800,
  height = 400,
  showEMA9 = true,
  showEMA21 = true,
  showEMA50 = false,
  showSR = true,
  showVolume = true,
}) {
  const padding = { top: 30, right: 70, bottom: showVolume ? 80 : 40, left: 10 }
  const chartW = width - padding.left - padding.right
  const chartH = height - padding.top - padding.bottom - (showVolume ? 50 : 0)
  const volH = showVolume ? 50 : 0

  const { paths, emaLines, srLevels, yLabels, xLabels, volBars, priceRange, lastPrice } = useMemo(() => {
    if (priceHistory.length < 2) return { paths: '', emaLines: [], srLevels: [], yLabels: [], xLabels: [], volBars: [], priceRange: [0, 1], lastPrice: 0 }

    const prices = priceHistory.map(p => typeof p === 'object' ? (p.price || p.close || p.p || 0) : p)
    const timestamps = priceHistory.map(p => typeof p === 'object' ? (p.timestamp || p.t || p.time || 0) : 0)
    const vols = volumes.length > 0 ? volumes : priceHistory.map(p => typeof p === 'object' ? (p.volume || p.v || 0) : 0)

    const minP = Math.min(...prices) * 0.97
    const maxP = Math.max(...prices) * 1.03
    const range = maxP - minP || 0.01

    const scaleX = (i) => padding.left + (i / (prices.length - 1)) * chartW
    const scaleY = (p) => padding.top + chartH - ((p - minP) / range) * chartH

    // Price line path
    const linePoints = prices.map((p, i) => `${scaleX(i)},${scaleY(p)}`).join(' ')
    const areaPoints = `${scaleX(0)},${scaleY(prices[0])} ${linePoints} ${scaleX(prices.length - 1)},${padding.top + chartH} ${scaleX(0)},${padding.top + chartH}`

    // EMAs
    const ema9 = showEMA9 ? calcEMA(prices, 9) : []
    const ema21 = showEMA21 ? calcEMA(prices, 21) : []
    const ema50 = showEMA50 ? calcEMA(prices, 50) : []

    const emaToPath = (ema) => {
      const pts = ema
        .map((v, i) => v != null ? `${scaleX(i)},${scaleY(v)}` : null)
        .filter(Boolean)
      return pts.length > 1 ? `M${pts.join(' L')}` : ''
    }

    const emas = []
    if (showEMA9 && ema9.length) emas.push({ path: emaToPath(ema9), color: '#f59e0b', label: 'EMA 9', lastVal: ema9.filter(v => v != null).pop() })
    if (showEMA21 && ema21.length) emas.push({ path: emaToPath(ema21), color: '#a855f7', label: 'EMA 21', lastVal: ema21.filter(v => v != null).pop() })
    if (showEMA50 && ema50.length) emas.push({ path: emaToPath(ema50), color: '#ec4899', label: 'EMA 50', lastVal: ema50.filter(v => v != null).pop() })

    // Support/Resistance
    const sr = showSR ? findSupportResistance(prices) : []
    const srLines = sr.map(level => ({
      y: scaleY(level.price),
      price: level.price,
      type: level.type,
    }))

    // Y-axis labels
    const numLabels = 6
    const yLabels = Array.from({ length: numLabels }, (_, i) => {
      const price = minP + (range * i / (numLabels - 1))
      return { y: scaleY(price), label: (price * 100).toFixed(1) + '%' }
    })

    // X-axis labels (timestamps)
    const xLabelCount = Math.min(6, prices.length)
    const xLabels = timestamps[0] ? Array.from({ length: xLabelCount }, (_, i) => {
      const idx = Math.floor((i / (xLabelCount - 1)) * (prices.length - 1))
      const ts = timestamps[idx]
      const d = new Date(ts)
      return {
        x: scaleX(idx),
        label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      }
    }) : []

    // Volume bars
    const maxVol = Math.max(...vols, 1)
    const volBarData = vols.map((v, i) => ({
      x: scaleX(i) - (chartW / prices.length / 2),
      width: Math.max(1, chartW / prices.length - 1),
      height: (v / maxVol) * volH,
      y: padding.top + chartH + (volH - (v / maxVol) * volH) + 10,
      isUp: i > 0 ? prices[i] >= prices[i - 1] : true,
    }))

    return {
      paths: { line: `M${linePoints}`, area: `M${areaPoints}Z` },
      emaLines: emas,
      srLevels: srLines,
      yLabels,
      xLabels,
      volBars: showVolume ? volBarData : [],
      priceRange: [minP, maxP],
      lastPrice: prices[prices.length - 1],
    }
  }, [priceHistory, volumes, width, height, showEMA9, showEMA21, showEMA50, showSR, showVolume])

  if (priceHistory.length < 2) {
    return (
      <div className="flex items-center justify-center" style={{ width, height }}>
        <p className="text-gray-600 text-sm">Not enough price data for chart</p>
      </div>
    )
  }

  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00d4ff" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#00d4ff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="lineGradient" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#00d4ff" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#00d4ff" stopOpacity="1" />
        </linearGradient>
        <filter id="glow">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Grid lines */}
      {yLabels.map((label, i) => (
        <g key={`grid-${i}`}>
          <line
            x1={padding.left} x2={width - padding.right}
            y1={label.y} y2={label.y}
            stroke="rgba(255,255,255,0.04)" strokeWidth="1"
          />
          <text x={width - padding.right + 8} y={label.y + 4}
            fill="rgba(255,255,255,0.3)" fontSize="10" fontFamily="JetBrains Mono, monospace"
          >
            {label.label}
          </text>
        </g>
      ))}

      {/* X-axis labels */}
      {xLabels.map((label, i) => (
        <text key={`x-${i}`} x={label.x} y={height - 8}
          fill="rgba(255,255,255,0.25)" fontSize="10" textAnchor="middle"
          fontFamily="JetBrains Mono, monospace"
        >
          {label.label}
        </text>
      ))}

      {/* Support/Resistance levels */}
      {srLevels.map((level, i) => (
        <g key={`sr-${i}`}>
          <line
            x1={padding.left} x2={width - padding.right}
            y1={level.y} y2={level.y}
            stroke={level.type === 'resistance' ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.3)'}
            strokeWidth="1" strokeDasharray="4,4"
          />
          <text x={padding.left + 4} y={level.y - 4}
            fill={level.type === 'resistance' ? 'rgba(239,68,68,0.5)' : 'rgba(16,185,129,0.5)'}
            fontSize="9" fontFamily="JetBrains Mono, monospace"
          >
            {level.type === 'resistance' ? 'R' : 'S'} {(level.price * 100).toFixed(1)}%
          </text>
        </g>
      ))}

      {/* Area fill */}
      {paths.area && (
        <motion.path
          d={paths.area}
          fill="url(#priceGradient)"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1 }}
        />
      )}

      {/* Price line */}
      {paths.line && (
        <motion.path
          d={paths.line}
          fill="none"
          stroke="url(#lineGradient)"
          strokeWidth="2"
          strokeLinejoin="round"
          filter="url(#glow)"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.5, ease: [0.16, 1, 0.3, 1] }}
        />
      )}

      {/* EMA lines */}
      {emaLines.map((ema, i) => ema.path && (
        <motion.path
          key={`ema-${i}`}
          d={ema.path}
          fill="none"
          stroke={ema.color}
          strokeWidth="1.5"
          strokeDasharray="3,2"
          opacity="0.6"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.2, delay: 0.3 + i * 0.15 }}
        />
      ))}

      {/* EMA labels on right edge */}
      {emaLines.map((ema, i) => ema.lastVal != null && (
        <text key={`ema-label-${i}`}
          x={width - padding.right + 8}
          y={padding.top + chartH - ((ema.lastVal - priceRange[0]) / (priceRange[1] - priceRange[0])) * chartH + 4}
          fill={ema.color} fontSize="9" fontFamily="JetBrains Mono, monospace" opacity="0.7"
        >
          {ema.label}
        </text>
      ))}

      {/* Volume bars */}
      {volBars.map((bar, i) => (
        <motion.rect
          key={`vol-${i}`}
          x={bar.x} y={bar.y}
          width={bar.width} height={bar.height}
          fill={bar.isUp ? 'rgba(16,185,129,0.25)' : 'rgba(239,68,68,0.25)'}
          rx="1"
          initial={{ scaleY: 0 }}
          animate={{ scaleY: 1 }}
          transition={{ delay: 0.5 + i * 0.005, duration: 0.3 }}
          style={{ transformOrigin: `${bar.x + bar.width / 2}px ${bar.y + bar.height}px` }}
        />
      ))}
      {showVolume && (
        <text x={padding.left + 4} y={padding.top + chartH + 20}
          fill="rgba(255,255,255,0.2)" fontSize="9" fontFamily="JetBrains Mono, monospace"
        >
          VOLUME
        </text>
      )}

      {/* Last price indicator */}
      {lastPrice > 0 && (
        <g>
          <line
            x1={width - padding.right - 5} x2={width - padding.right}
            y1={padding.top + chartH - ((lastPrice - priceRange[0]) / (priceRange[1] - priceRange[0])) * chartH}
            y2={padding.top + chartH - ((lastPrice - priceRange[0]) / (priceRange[1] - priceRange[0])) * chartH}
            stroke="#00d4ff" strokeWidth="2"
          />
          <rect
            x={width - padding.right + 2}
            y={padding.top + chartH - ((lastPrice - priceRange[0]) / (priceRange[1] - priceRange[0])) * chartH - 10}
            width="55" height="20" rx="4"
            fill="rgba(0,212,255,0.15)" stroke="rgba(0,212,255,0.3)" strokeWidth="1"
          />
          <text
            x={width - padding.right + 8}
            y={padding.top + chartH - ((lastPrice - priceRange[0]) / (priceRange[1] - priceRange[0])) * chartH + 4}
            fill="#00d4ff" fontSize="11" fontWeight="600" fontFamily="JetBrains Mono, monospace"
          >
            {(lastPrice * 100).toFixed(1)}%
          </text>
        </g>
      )}
    </svg>
  )
}
