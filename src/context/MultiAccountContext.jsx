import React, { createContext, useContext, useState, useEffect, useRef } from 'react'
import useApi from '../hooks/useApi'

const MultiAccountContext = createContext()

export function MultiAccountProvider({ children }) {
  const [accounts, setAccounts] = useState({})
  const [comparison, setComparison] = useState(null)
  const [liveTrades, setLiveTrades] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)
  const prevTradeCount = useRef({})
  const api = useApi()

  useEffect(() => {
    let mounted = true

    const fetchComparison = async () => {
      try {
        const res = await api.get('/accounts/compare').catch(() => null)
        if (!mounted) return
        if (res?.success && res.data) {
          let { accounts: accts, comparison: cmp, timestamp } = res.data
          const compareIds = Object.keys(accts || {})
          if (compareIds.length < 2) {
            const accountsRes = await api.get('/accounts').catch(() => null)
            const list = accountsRes?.success ? (accountsRes.data || []) : []
            accts = {}
            list.forEach(a => {
              if (!a?.id) return
              const portfolio = a.portfolio || {}
              const trades = portfolio.trades || []
              const positions = portfolio.positions || {}
              const closedTrades = trades.filter(t => t.realizedPnl != null)
              const openTrades = trades.filter(t => t.realizedPnl == null)
              const wins = closedTrades.filter(t => t.realizedPnl > 0)
              const losses = closedTrades.filter(t => t.realizedPnl < 0)
              const hasClosedData = closedTrades.length > 0
              const pnl = a.pnl || portfolio.pnl || { realized: 0, unrealized: 0, total: 0 }
              const totalValue = a.totalValue || portfolio.totalValue || (portfolio.cash || 0) + (pnl.unrealized || 0)
              const winRate = hasClosedData
                ? parseFloat((wins.length / closedTrades.length * 100).toFixed(1))
                : 0

              const edgeSum = trades.reduce((s, t) => s + (t.edgePercent || 0), 0)
              const avgEdge = trades.length > 0 ? ((edgeSum / trades.length) * 100).toFixed(2) : '0.00'
              const allTrades = trades.length > 0 ? trades : (a.recentTrades || [])

              // More realistic hit rate: include mark-to-market open positions.
              const openPositions = Object.values(positions).filter(p => p?.status === 'open')
              let openWinCount = 0
              let openLossCount = 0
              for (const p of openPositions) {
                const yesShares = Number(p.yesShares || 0)
                const noShares = Number(p.noShares || 0)
                const curYes = Number(p.currentYesPrice)
                const curNo = Number(p.currentNoPrice)
                const entryCost = Number(p.entryCost || 0)
                if (!Number.isFinite(curYes) || !Number.isFinite(curNo) || entryCost <= 0) continue
                const currentValue = yesShares * curYes + noShares * curNo
                const openPnl = currentValue - entryCost
                if (openPnl > 0) openWinCount++
                else if (openPnl < 0) openLossCount++
              }
              const realisticDenominator = wins.length + losses.length + openWinCount + openLossCount
              const realisticWinRate = realisticDenominator > 0
                ? (wins.length + openWinCount) / realisticDenominator * 100
                : 0

              const startingCapital = 10000
              const closedEvents = trades
                .filter(t => t.realizedPnl != null)
                .map(t => {
                  const openTs = t.timestamp ? new Date(t.timestamp).getTime() : Date.now()
                  const closeTs = t.closedAt ? new Date(t.closedAt).getTime() : openTs + 60000
                  return { ts: closeTs, realizedPnl: Number(t.realizedPnl || 0) }
                })
                .sort((a, b) => a.ts - b.ts)

              const firstTs = closedEvents.length > 0
                ? Math.floor(closedEvents[0].ts / 1000) - 3600
                : Math.floor(Date.now() / 1000) - 86400
              const curve = [{ time: firstTs, value: startingCapital }]
              let lastTime = firstTs
              let equity = startingCapital

              for (const ev of closedEvents) {
                equity += ev.realizedPnl
                let ts = Math.floor(ev.ts / 1000)
                if (ts <= lastTime) ts = lastTime + 1
                lastTime = ts
                curve.push({ time: ts, value: parseFloat(equity.toFixed(2)) })
              }

              const nowTs = Math.floor(Date.now() / 1000)
              if (nowTs > lastTime) {
                curve.push({ time: nowTs, value: totalValue || startingCapital })
              }

              accts[a.id] = {
                id: a.id,
                cash: portfolio.cash || 0,
                totalValue,
                totalReturn: parseFloat(a?.performance?.totalReturn || 0) || 0,
                openPositions: portfolio.openPositions || 0,
                closedPositions: portfolio.closedPositions || 0,
                totalTrades: a?.performance?.totalTrades ?? trades.length,
                closedTradeCount: a?.performance?.closedTrades ?? closedTrades.length,
                openTradeCount: (a?.performance?.totalTrades ?? trades.length) - (a?.performance?.closedTrades ?? closedTrades.length),
                winCount: a?.performance?.winningTrades ?? wins.length,
                lossCount: a?.performance?.losingTrades ?? losses.length,
                winRate: parseFloat(a?.performance?.winRate || winRate) || 0,
                winRateIsEstimated: !hasClosedData && !(a?.performance?.closedTrades > 0),
                avgEdge,
                profitFactor: parseFloat(a?.performance?.profitFactor || 0) || 0,
                pnl,
                recentTrades: (a.recentTrades || allTrades).slice(0, 80),
                equityCurve: curve,
                rust: a.rust || null,
                positions,
                closedWinRate: winRate,
                openWinCount,
                openLossCount,
                realisticWinRate,
              }
            })
            cmp = null
            timestamp = new Date().toISOString()
          }

          // Merge real recent trades from both accounts (live trades from API)
          if (accts) {
            const merged = []
            for (const [id, acct] of Object.entries(accts)) {
              const list = acct.recentTrades || []
              list.forEach(t => merged.push({ ...t, accountId: id }))
            }
            merged.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
            setLiveTrades(merged.slice(0, 80))
            for (const id of Object.keys(accts)) {
              prevTradeCount.current[id] = accts[id].totalTrades || 0
            }
          }

          setAccounts(accts || {})
          setComparison(cmp || null)
          setLastUpdate(timestamp)
          setError(null)
        }
      } catch (err) {
        if (mounted) setError(err.message)
      } finally {
        if (mounted) setLoading(false)
      }
    }

    fetchComparison()
    const interval = setInterval(fetchComparison, 2500)
    return () => { mounted = false; clearInterval(interval) }
  }, [])

  const value = {
    accounts,
    comparison,
    liveTrades,
    loading,
    error,
    lastUpdate,
    accountIds: Object.keys(accounts),
  }

  return (
    <MultiAccountContext.Provider value={value}>
      {children}
    </MultiAccountContext.Provider>
  )
}

export function useMultiAccount() {
  const ctx = useContext(MultiAccountContext)
  if (!ctx) throw new Error('useMultiAccount must be used within MultiAccountProvider')
  return ctx
}
