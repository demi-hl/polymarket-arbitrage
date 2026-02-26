import { useEffect, useRef, useState, useCallback } from 'react'

export default function useWebSocket(url) {
  const [connected, setConnected] = useState(false)
  const ws = useRef(null)

  useEffect(() => {
    const socket = new WebSocket(url)
    
    socket.onopen = () => {
      setConnected(true)
      socket.send(JSON.stringify({ type: 'subscribe', channel: 'all' }))
    }
    
    socket.onclose = () => setConnected(false)
    socket.onerror = () => setConnected(false)
    
    ws.current = socket
    
    return () => socket.close()
  }, [url])

  const sendMessage = useCallback((message) => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(message))
    }
  }, [])

  return { ws: ws.current, connected, sendMessage }
}
