import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import useWebSocket from '../hooks/useWebSocket'
import useApi from '../hooks/useApi'

const TradingContext = createContext()

export function TradingProvider({ children }) {
  const [portfolio, setPortfolio] = useState(null)
  const [opportunities, setOpportunities] = useState([])
  const [trades, setTrades] = useState([])
  const [strategies, setStrategies] = useState([])
  const [systemStatus, setSystemStatus] = useState({ connected: false })
  const [loading, setLoading] = useState(true)
  
  const { ws, connected } = useWebSocket('ws://localhost:8082')
  const api = useApi()

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true)
        const [portfolioRes, strategiesRes] = await Promise.all([
          api.get('/portfolio'),
          api.get('/strategies'),
        ])
        
        if (portfolioRes.success) setPortfolio(portfolioRes.data)
        if (strategiesRes.success) setStrategies(strategiesRes.data)
        
        const oppRes = await api.get('/opportunities?threshold=5')
        if (oppRes.success) setOpportunities(oppRes.data.opportunities || [])
        
        const tradesRes = await api.get('/trades')
        if (tradesRes.success) setTrades(tradesRes.data || [])
      } catch (err) {
        console.error('Failed to fetch data:', err)
      } finally {
        setLoading(false)
      }
    }
    
    fetchData()
    const interval = setInterval(fetchData, 30000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!ws) return
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message.channel === 'opportunities') setOpportunities(message.data)
        if (message.channel === 'trades') setTrades(prev => [message.data, ...prev])
      } catch (err) {}
    }
  }, [ws])

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
    systemStatus: { ...systemStatus, connected },
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
