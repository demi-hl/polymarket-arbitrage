import { useCallback } from 'react'

const API_BASE = '/api'

export default function useApi() {
  const request = useCallback(async (method, endpoint, body = null) => {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
    }
    if (body) options.body = JSON.stringify(body)
    
    const res = await fetch(`${API_BASE}${endpoint}`, options)
    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) {
      const text = await res.text()
      throw new Error(`API returned ${res.status} (expected JSON): ${text.slice(0, 80)}`)
    }
    return res.json()
  }, [])

  return {
    get: (endpoint) => request('GET', endpoint),
    post: (endpoint, body) => request('POST', endpoint, body),
    put: (endpoint, body) => request('PUT', endpoint, body),
    delete: (endpoint) => request('DELETE', endpoint),
  }
}
