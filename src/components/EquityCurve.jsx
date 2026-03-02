import React, { useEffect, useRef, useState } from 'react'
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
        textColor: 'rgba(255,255,255,0.25)',
        fontFamily: 'JetBrains Mono, SF Mono, monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.03)' },
        horzLines: { color: 'rgba(255,255,255,0.03)' },
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: 'rgba(255,255,255,0.1)', labelBackgroundColor: '#12121a' },
        horzLine: { color: 'rgba(255,255,255,0.1)', labelBackgroundColor: '#12121a' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.04)',
        scaleMargins: { top: 0.15, bottom: 0.1 },
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.04)',
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
        crosshairMarkerRadius: 4,
        crosshairMarkerBorderColor: '#12121a',
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
      <div className="h-full flex flex-col items-center justify-center py-12 border border-white/[0.04] rounded-lg">
        <p className="text-[11px] uppercase tracking-[0.2em] text-gray-500 mb-2">Equity curve</p>
        <p className="text-xs text-gray-600">Appears after trades</p>
      </div>
    )
  }

  const maxLen = Math.max(...ids.map(id => (accounts[id]?.equityCurve || []).length))
  const tradeCount = Math.max(0, maxLen - 2)

  return (
    <div className="border border-white/[0.04] rounded-lg py-5 px-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-gray-500">Equity curve</p>
          <p className="text-[10px] text-gray-600 mt-0.5">{tradeCount} trade{tradeCount !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex items-center gap-4">
          {ids.map(id => {
            const label = id === 'paper' ? 'Paper' : `Account ${id}`
            return (
              <div key={id} className="flex items-center gap-1.5">
                <div className="w-3 h-0.5 rounded-full" style={{ background: COLORS[id] || '#666' }} />
                <span className="text-[10px] text-gray-500">
                  {label}
                  {hoveredValues?.[id] != null && (
                    <span className="ml-1 font-mono" style={{ color: COLORS[id] }}>
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
