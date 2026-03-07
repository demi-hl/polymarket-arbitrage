import React from 'react'
import { motion } from 'framer-motion'

const ease = [0.16, 1, 0.3, 1]

export default function PulseRing({
  value = 0,
  max = 100,
  size = 64,
  strokeWidth = 3,
  color = '#00d4ff',
  bgColor = 'rgba(255,255,255,0.04)',
  label,
  children,
  delay = 0,
  className = '',
}) {
  const radius = (size - strokeWidth * 2) / 2
  const circumference = 2 * Math.PI * radius
  const pct = Math.min(Math.max(value / max, 0), 1)
  const offset = circumference * (1 - pct)

  return (
    <div className={`relative inline-flex items-center justify-center ${className}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="absolute inset-0 -rotate-90">
        {/* Background ring */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={bgColor}
          strokeWidth={strokeWidth}
        />
        {/* Value ring with animated draw */}
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 1.2, delay, ease }}
          style={{
            filter: `drop-shadow(0 0 4px ${color}40)`,
          }}
        />
        {/* Glow dot at tip */}
        {pct > 0.02 && (
          <motion.circle
            cx={size / 2 + radius * Math.cos(2 * Math.PI * pct - Math.PI / 2)}
            cy={size / 2 + radius * Math.sin(2 * Math.PI * pct - Math.PI / 2)}
            r={strokeWidth}
            fill={color}
            initial={{ opacity: 0 }}
            animate={{ opacity: [0.6, 1, 0.6] }}
            transition={{ repeat: Infinity, duration: 2, delay }}
            style={{ filter: `drop-shadow(0 0 6px ${color}80)` }}
          />
        )}
      </svg>
      {/* Center content */}
      <div className="relative z-10 flex flex-col items-center justify-center">
        {children || (
          <>
            <span className="font-mono text-sm font-semibold tabular-nums" style={{ color, fontSize: size * 0.22 }}>
              {typeof value === 'number' ? `${Math.round(pct * 100)}%` : value}
            </span>
            {label && (
              <span className="text-gray-600 uppercase tracking-[0.15em]" style={{ fontSize: Math.max(7, size * 0.11) }}>
                {label}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  )
}
