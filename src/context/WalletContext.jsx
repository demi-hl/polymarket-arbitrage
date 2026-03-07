import React, { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { ethers } from 'ethers'
import { toast } from 'sonner'

const HYPEREVM_CHAIN = {
  chainId: '0x3E7', // 999
  chainName: 'HyperEVM',
  nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: ['https://rpc.hyperliquid.xyz/evm'],
  blockExplorerUrls: ['https://explorer.hyperliquid.xyz'],
}

const NFT_CONTRACT = '0x62FCFAf7573AD8B41a0FBF347AfEb85e06599A75'
const ERC721_ABI = ['function balanceOf(address owner) view returns (uint256)']

const WalletContext = createContext()

export function WalletProvider({ children }) {
  const [address, setAddress] = useState(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [nftVerified, setNftVerified] = useState(null) // null=unchecked, true/false
  const [nftBalance, setNftBalance] = useState(0)
  const [checking, setChecking] = useState(false)
  const [jwt, setJwt] = useState(null)
  const [isAuthenticated, setIsAuthenticated] = useState(false)

  // Reconnect on mount if previously connected
  useEffect(() => {
    const saved = localStorage.getItem('demi_wallet_address')
    const savedJwt = localStorage.getItem('locals_jwt')
    if (savedJwt) {
      setJwt(savedJwt)
      setIsAuthenticated(true)
    }
    if (saved && window.ethereum) {
      window.ethereum.request({ method: 'eth_accounts' })
        .then(accounts => {
          if (accounts[0]?.toLowerCase() === saved.toLowerCase()) {
            setAddress(accounts[0])
          } else {
            localStorage.removeItem('demi_wallet_address')
            localStorage.removeItem('locals_jwt')
          }
        })
        .catch(() => {})
    }
  }, [])

  // Verify NFT ownership when address changes
  useEffect(() => {
    if (!address) {
      setNftVerified(null)
      setNftBalance(0)
      return
    }
    verifyNFT(address)
  }, [address])

  const verifyNFT = useCallback(async (addr) => {
    setChecking(true)
    try {
      const provider = new ethers.JsonRpcProvider(HYPEREVM_CHAIN.rpcUrls[0])
      const contract = new ethers.Contract(NFT_CONTRACT, ERC721_ABI, provider)
      const balance = await contract.balanceOf(addr)
      const bal = Number(balance)
      setNftBalance(bal)
      setNftVerified(bal > 0)
      if (bal > 0) {
        toast.success(`Locals Only verified: ${bal} NFT${bal > 1 ? 's' : ''} found`)
      }
    } catch (err) {
      console.error('[WalletContext] NFT check failed:', err.message)
      // On RPC failure, allow access (fail-open for operator)
      setNftVerified(true)
      toast.error('Locals Only check failed — defaulting to allowed')
    } finally {
      setChecking(false)
    }
  }, [])

  // ── Backend Authentication (SIWE pattern) ──
  const authenticate = useCallback(async (addr) => {
    try {
      // 1. Request nonce from backend
      const nonceRes = await fetch('/api/auth/nonce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr }),
      })
      const nonceData = await nonceRes.json()
      if (!nonceData.success) {
        toast.error('Auth failed: ' + (nonceData.error || 'Could not get nonce'))
        return false
      }

      // 2. Sign the message with MetaMask
      const signature = await window.ethereum.request({
        method: 'personal_sign',
        params: [nonceData.message, addr],
      })

      // 3. Verify signature + NFT on backend
      const verifyRes = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: addr,
          signature,
          message: nonceData.message,
        }),
      })
      const verifyData = await verifyRes.json()

      if (verifyData.success && verifyData.token) {
        setJwt(verifyData.token)
        setIsAuthenticated(true)
        localStorage.setItem('locals_jwt', verifyData.token)
        setNftBalance(verifyData.user.nftBalance)
        setNftVerified(true)
        toast.success('Authenticated — welcome to Locals Only')
        return true
      } else {
        toast.error(verifyData.error || 'Authentication failed')
        return false
      }
    } catch (err) {
      if (err.code === 4001) {
        toast.error('Signature rejected')
      } else {
        console.error('[WalletContext] Auth error:', err)
        toast.error('Authentication failed: ' + err.message)
      }
      return false
    }
  }, [])

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      toast.error('No wallet detected. Install MetaMask or a browser wallet.')
      return
    }
    setIsConnecting(true)
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' })
      if (accounts[0]) {
        setAddress(accounts[0])
        localStorage.setItem('demi_wallet_address', accounts[0])
        // Auto-authenticate after wallet connect
        await authenticate(accounts[0])
      }
    } catch (err) {
      if (err.code === 4001) {
        toast.error('Connection rejected')
      } else {
        toast.error('Failed to connect wallet')
      }
    } finally {
      setIsConnecting(false)
    }
  }, [authenticate])

  const disconnect = useCallback(() => {
    setAddress(null)
    setNftVerified(null)
    setNftBalance(0)
    setJwt(null)
    setIsAuthenticated(false)
    localStorage.removeItem('demi_wallet_address')
    localStorage.removeItem('locals_jwt')
    toast('Wallet disconnected')
  }, [])

  // Listen for account/chain changes
  useEffect(() => {
    if (!window.ethereum) return
    const onAccountsChanged = (accounts) => {
      if (accounts[0]) {
        setAddress(accounts[0])
        localStorage.setItem('demi_wallet_address', accounts[0])
        // Re-authenticate with new account
        authenticate(accounts[0])
      } else {
        disconnect()
      }
    }
    window.ethereum.on('accountsChanged', onAccountsChanged)
    return () => window.ethereum.removeListener('accountsChanged', onAccountsChanged)
  }, [disconnect, authenticate])

  const value = {
    address,
    isConnecting,
    checking,
    nftVerified,
    nftBalance,
    jwt,
    isAuthenticated,
    connect,
    disconnect,
    authenticate,
    verifyNFT,
    nftContract: NFT_CONTRACT,
    chain: HYPEREVM_CHAIN,
  }

  return (
    <WalletContext.Provider value={value}>
      {children}
    </WalletContext.Provider>
  )
}

export function useWallet() {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error('useWallet must be used within WalletProvider')
  return ctx
}
