import React, { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { createChart, ColorType, CrosshairMode, AreaSeries } from 'lightweight-charts'

const COLORS = { A: '#f59e0b', B: '#00d4ff', paper: '#10b981' }

export default function EquityCurve({ accounts = {} }) {
  const chartRef = useRef(null)
  const chartInstance = useRef(null)
  const seriesRefs = useRef({})
  const [hoveredValues, setHoveredValues] = useState(null)
  const ids = Object.keys(accounts)

  useEffect(() => {
    if (!chartRef.current || ids.length === 0) return

    if (chartInstance.current) {
      chartInstance.current.remove()
      chartInstance.current = null
      seriesRefs.current = {}
    }

    const chart = createChart(chartRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'rgba(255,255,255,0.2)',
        fontFamily: 'JetBrains Mono, SF Mono, monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(0, 212, 255, 0.02)' },
        horzLines: { color: 'rgba(0, 212, 255, 0.02)' },
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: 'rgba(0, 212, 255, 0.15)', labelBackgroundColor: '#0e0e16' },
        horzLine: { color: 'rgba(0, 212, 255, 0.15)', labelBackgroundColor: '#0e0e16' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.03)',
        scaleMargins: { top: 0.15, bottom: 0.1 },
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.03)',
        timeVisible: true,
        secondsVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true },
    })

    chartInstance.current = chart

    for (const id of ids) {
      const curve = accounts[id]?.equityCurve || [{ time: Math.floor(Date.now() / 1000), value: 10000 }]
      const data = curve.map((pt) => ({
        time: typeof pt.time === 'number' && pt.time > 1000000000 ? pt.time : Math.floor(Date.now() / 1000),
        value: pt.value,
      }))

      const color = COLORS[id] || '#666'
      const series = chart.addSeries(AreaSeries, {
        lineColor: color,
        lineWidth: 2,
        topColor: color.replace(')', ', 0.15)').replace('rgb', 'rgba').replace('#', ''),
        bottomColor: 'transparent',
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 5,
        crosshairMarkerBorderColor: '#0e0e16',
        crosshairMarkerBorderWidth: 2,
        crosshairMarkerBackgroundColor: color,
        lastValueVisible: true,
        priceLineVisible: false,
      })

      const areaTop = `${color}26`
      series.applyOptions({ topColor: areaTop, bottomColor: 'transparent' })
      series.setData(data)
      seriesRefs.current[id] = series
    }

    chart.subscribeCrosshairMove((param) => {
      if (!param.time && param.point === undefined) {
        setHoveredValues(null)
        return
      }
      const vals = {}
      for (const id of ids) {
        const s = seriesRefs.current[id]
        if (s) {
          const d = param.seriesData?.get(s)
          if (d) vals[id] = d.value
        }
      }
      if (Object.keys(vals).length > 0) setHoveredValues(vals)
    })

    chart.timeScale().fitContent()

    const ro = new ResizeObserver(() => {
      if (chartRef.current && chartInstance.current) {
        chartInstance.current.applyOptions({
          width: chartRef.current.clientWidth,
          height: chartRef.current.clientHeight,
        })
      }
    })
    ro.observe(chartRef.current)

    return () => {
      ro.disconnect()
      if (chartInstance.current) {
        chartInstance.current.remove()
        chartInstance.current = null
      }
    }
  }, [JSON.stringify(Object.keys(accounts)), JSON.stringify(
    ids.map(id => (accounts[id]?.equityCurve || []).length)
  )])

  if (ids.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center py-12 card">
        <motion.div animate={{ opacity: [0.4, 0.7, 0.4] }} transition={{ repeat: Infinity, duration: 3 }}>
          <p className="text-[11px] uppercase tracking-[0.2em] text-gray-500 mb-2">Total value</p>
          <p className="text-xs text-gray-600">Appears after trades</p>
        </motion.div>
      </div>
    )
  }

  const maxLen = Math.max(...ids.map(id => (accounts[id]?.equityCurve || []).length))
  const tradeCount = Math.max(0, maxLen - 2)

  return (
    <div className="card" style={{ padding: '20px 20px' }}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-gray-400 font-medium">Total value</p>
          <p className="text-[10px] text-gray-600 mt-0.5">{tradeCount} trade{tradeCount !== 1 ? 's' : ''} tracked</p>
        </div>
        <div className="flex items-center gap-4">
          {ids.map(id => {
            const label = id === 'paper' ? 'Total Value' : `Account ${id}`
            return (
              <div key={id} className="flex items-center gap-2">
                <div className="w-3 h-1 rounded-full" style={{ background: COLORS[id] || '#666', boxShadow: `0 0 6px ${COLORS[id] || '#666'}40` }} />
                <span className="text-[10px] text-gray-500">
                  {label}
                  {hoveredValues?.[id] != null && (
                    <span className="ml-1 font-mono font-medium" style={{ color: COLORS[id], textShadow: `0 0 8px ${COLORS[id]}30` }}>
                      ${hoveredValues[id].toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      <div ref={chartRef} style={{ height: 280, width: '100%' }} />
    </div>
  )
}
