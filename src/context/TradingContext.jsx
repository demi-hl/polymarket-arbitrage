import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import useApi from '../hooks/useApi'

const TradingContext = createContext()

export function TradingProvider({ children }) {
  const [portfolio, setPortfolio] = useState(null)
  const [opportunities, setOpportunities] = useState([])
  const [opportunitiesMeta, setOpportunitiesMeta] = useState({ stale: false, warning: null, marketsScanned: 0 })
  const [trades, setTrades] = useState([])
  const [strategies, setStrategies] = useState([])
  const [systemStatus, setSystemStatus] = useState({ connected: true })
  const [loading, setLoading] = useState(true)
  const [selectedAccount, setSelectedAccount] = useState('paper')
  const [accountIds, setAccountIds] = useState([])
  const seenTradeIds = useRef(new Set())
  const seenKeyRef = useRef('trade-seen-ids')
  const initialLoad = useRef(true)

  const api = useApi()

  useEffect(() => {
    let cancelled = false

    const fetchCore = async () => {
      try {
        if (initialLoad.current) setLoading(true)

        const [strategiesRes, accountsRes] = await Promise.all([
          api.get('/strategies').catch(() => null),
          api.get('/accounts').catch(() => null),
        ])

        if (cancelled) return

        if (strategiesRes?.success) setStrategies(strategiesRes.data)
        const availableIds = (accountsRes?.success ? (accountsRes.data || []).map(a => a.id).filter(Boolean) : [])
        setAccountIds(availableIds)

        const effectiveAccount = availableIds.includes(selectedAccount)
          ? selectedAccount
          : (availableIds[0] || selectedAccount)
        if (effectiveAccount !== selectedAccount) setSelectedAccount(effectiveAccount)
        seenKeyRef.current = `trade-seen-ids:${effectiveAccount || 'paper'}`

        const portfolioRes = effectiveAccount
          ? await api.get(`/accounts/${effectiveAccount}/portfolio`).catch(() => null)
          : await api.get('/portfolio').catch(() => null)

        if (portfolioRes?.success && portfolioRes.data) {
          const newTrades = portfolioRes.data.trades || []
          if (seenTradeIds.current.size === 0 && typeof window !== 'undefined') {
            try {
              const raw = window.sessionStorage.getItem(seenKeyRef.current)
              if (raw) {
                const parsed = JSON.parse(raw)
                if (Array.isArray(parsed)) {
                  seenTradeIds.current = new Set(parsed.filter(Boolean))
                }
              }
            } catch {}
          }

          // Trades are sorted newest-first. Track IDs to avoid duplicate or stale toasts.
          if (seenTradeIds.current.size === 0) {
            newTrades.slice(0, 200).forEach(t => {
              if (t?.id) seenTradeIds.current.add(t.id)
            })
          } else {
            const newestUnseen = newTrades.find(t => t?.id && !seenTradeIds.current.has(t.id))
            if (newestUnseen) {
              toast.success(
                `Trade executed: ${(newestUnseen.question || '').substring(0, 40)}...`,
                {
                  description: `${newestUnseen.strategy || 'arbitrage'} · ${((newestUnseen.edgePercent || 0) * 100).toFixed(1)}% edge · $${(newestUnseen.totalCost || 0).toFixed(2)}`,
                  duration: 5000,
                }
              )
            }
            newTrades.slice(0, 200).forEach(t => {
              if (t?.id) seenTradeIds.current.add(t.id)
            })
            if (seenTradeIds.current.size > 2000) {
              seenTradeIds.current = new Set(newTrades.slice(0, 300).map(t => t.id).filter(Boolean))
            }
          }
          if (typeof window !== 'undefined') {
            try {
              window.sessionStorage.setItem(
                seenKeyRef.current,
                JSON.stringify(Array.from(seenTradeIds.current).slice(-600))
              )
            } catch {}
          }
          setPortfolio(portfolioRes.data)
          setTrades(newTrades)
          setSystemStatus({ connected: true })
        } else {
          setSystemStatus({ connected: false })
        }
      } catch (err) {
        console.error('Failed to fetch core data:', err)
        if (!cancelled) setSystemStatus({ connected: false })
      } finally {
        if (!cancelled) {
          setLoading(false)
          initialLoad.current = false
        }
      }
    }

    const fetchOpportunities = async () => {
      try {
        const oppRes = await api.get('/opportunities?threshold=5')
        if (!cancelled && oppRes?.success) {
          setOpportunities(oppRes.data?.opportunities || [])
          setOpportunitiesMeta({
            stale: !!oppRes.data?.stale,
            warning: oppRes.data?.warning || null,
            marketsScanned: oppRes.data?.marketsScanned || 0,
          })
        }
      } catch (err) {
        // opportunities scan can be slow/fail — don't block UI
      }
    }

    fetchCore()
    fetchOpportunities()

    const coreInterval = setInterval(fetchCore, 2000)
    const oppInterval = setInterval(fetchOpportunities, 15000)
    return () => {
      cancelled = true
      clearInterval(coreInterval)
      clearInterval(oppInterval)
    }
  }, [selectedAccount])

  const executeTrade = useCallback(async (marketId, size) => {
    try {
      const res = await api.post('/execute', { marketId, size })
      if (res.success) {
        const portfolioRes = await api.get('/portfolio')
        if (portfolioRes.success) setPortfolio(portfolioRes.data)
        return { success: true, trade: res.data }
      }
      return { success: false, error: res.error }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [api])

  const value = {
    portfolio, opportunities, trades, strategies,
    opportunitiesMeta,
    selectedAccount, setSelectedAccount, accountIds,
    systemStatus,
    loading, executeTrade,
  }

  return (
    <TradingContext.Provider value={value}>
      {children}
    </TradingContext.Provider>
  )
}

export function useTrading() {
  const context = useContext(TradingContext)
  if (!context) throw new Error('useTrading must be used within TradingProvider')
  return context
}
