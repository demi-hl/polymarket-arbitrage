import React, { useMemo } from 'react'
import { motion } from 'framer-motion'

const ease = [0.16, 1, 0.3, 1]

export default function Sparkline({
  data = [],
  width = 64,
  height = 24,
  color = '#00d4ff',
  fillOpacity = 0.15,
  strokeWidth = 1.5,
  animated = true,
  delay = 0,
  className = '',
}) {
  const path = useMemo(() => {
    if (!data.length) return { line: '', fill: '' }
    const min = Math.min(...data)
    const max = Math.max(...data)
    const range = max - min || 1
    const pad = 1

    const points = data.map((v, i) => ({
      x: pad + (i / (data.length - 1)) * (width - pad * 2),
      y: pad + (1 - (v - min) / range) * (height - pad * 2),
    }))

    // Smooth curve through points
    let line = `M ${points[0].x},${points[0].y}`
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1]
      const curr = points[i]
      const cpx = (prev.x + curr.x) / 2
      line += ` C ${cpx},${prev.y} ${cpx},${curr.y} ${curr.x},${curr.y}`
    }

    // Fill area under curve
    const last = points[points.length - 1]
    const first = points[0]
    const fill = `${line} L ${last.x},${height} L ${first.x},${height} Z`

    return { line, fill }
  }, [data, width, height])

  if (!data.length) return null

  const totalLength = width * 2 // approximate

  return (
    <svg width={width} height={height} className={className} style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id={`spark-fill-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={fillOpacity} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* Fill area */}
      <motion.path
        d={path.fill}
        fill={`url(#spark-fill-${color.replace('#', '')})`}
        initial={animated ? { opacity: 0 } : {}}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.8, delay: delay + 0.4 }}
      />

      {/* Line */}
      <motion.path
        d={path.line}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={animated ? { strokeDasharray: totalLength, strokeDashoffset: totalLength } : {}}
        animate={{ strokeDashoffset: 0 }}
        transition={{ duration: 1.2, delay, ease }}
        style={{ filter: `drop-shadow(0 0 3px ${color}30)` }}
      />

      {/* End dot */}
      {data.length > 1 && (
        <motion.circle
          cx={width - 1}
          cy={1 + (1 - (data[data.length - 1] - Math.min(...data)) / (Math.max(...data) - Math.min(...data) || 1)) * (height - 2)}
          r={2}
          fill={color}
          initial={animated ? { opacity: 0, scale: 0 } : {}}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: delay + 1, duration: 0.3 }}
          style={{ filter: `drop-shadow(0 0 4px ${color}60)` }}
        />
      )}
    </svg>
  )
}
