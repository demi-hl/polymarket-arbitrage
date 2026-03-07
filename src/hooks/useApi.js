import { useCallback } from 'react'
import { useWallet } from '../context/WalletContext'

const API_BASE = '/api'

export default function useApi() {
  const { jwt, disconnect } = useWallet()

  const request = useCallback(async (method, endpoint, body = null) => {
    const headers = { 'Content-Type': 'application/json' }
    if (jwt) headers['Authorization'] = `Bearer ${jwt}`

    const options = { method, headers }
    if (body) options.body = JSON.stringify(body)

    const res = await fetch(`${API_BASE}${endpoint}`, options)

    // Handle auth expiry — trigger re-login
    if (res.status === 401) {
      const data = await res.json().catch(() => ({}))
      if (data.code === 'INVALID_TOKEN' || data.code === 'NO_TOKEN') {
        disconnect()
        throw new Error('Session expired — please reconnect your wallet')
      }
    }

    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) {
      const text = await res.text()
      throw new Error(`API returned ${res.status} (expected JSON): ${text.slice(0, 80)}`)
    }
    return res.json()
  }, [jwt, disconnect])

  return {
    get: (endpoint) => request('GET', endpoint),
    post: (endpoint, body) => request('POST', endpoint, body),
    put: (endpoint, body) => request('PUT', endpoint, body),
    delete: (endpoint) => request('DELETE', endpoint),
  }
}
