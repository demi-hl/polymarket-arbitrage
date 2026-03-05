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

  // Reconnect on mount if previously connected
  useEffect(() => {
    const saved = localStorage.getItem('demi_wallet_address')
    if (saved && window.ethereum) {
      window.ethereum.request({ method: 'eth_accounts' })
        .then(accounts => {
          if (accounts[0]?.toLowerCase() === saved.toLowerCase()) {
            setAddress(accounts[0])
          } else {
            localStorage.removeItem('demi_wallet_address')
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
  }, [])

  const disconnect = useCallback(() => {
    setAddress(null)
    setNftVerified(null)
    setNftBalance(0)
    localStorage.removeItem('demi_wallet_address')
    toast('Wallet disconnected')
  }, [])

  // Listen for account/chain changes
  useEffect(() => {
    if (!window.ethereum) return
    const onAccountsChanged = (accounts) => {
      if (accounts[0]) {
        setAddress(accounts[0])
        localStorage.setItem('demi_wallet_address', accounts[0])
      } else {
        disconnect()
      }
    }
    window.ethereum.on('accountsChanged', onAccountsChanged)
    return () => window.ethereum.removeListener('accountsChanged', onAccountsChanged)
  }, [disconnect])

  const value = {
    address,
    isConnecting,
    checking,
    nftVerified,
    nftBalance,
    connect,
    disconnect,
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
