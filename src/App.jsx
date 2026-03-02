import React from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import { Toaster } from 'sonner'
import Sidebar from './components/Sidebar'
import Header from './components/Header'
import ParticleBackground from './components/ParticleBackground'
import PageTransition from './components/PageTransition'
import ErrorBoundary from './components/ErrorBoundary'
import Landing from './pages/Landing'
import Overview from './pages/Overview'
import ABTest from './pages/ABTest'
import Strategies from './pages/Strategies'
import Markets from './pages/Markets'
import Portfolio from './pages/Portfolio'
import Backtest from './pages/Backtest'
import { MultiAccountProvider } from './context/MultiAccountContext'
import { TradingProvider } from './context/TradingContext'

function AppLayout() {
  const location = useLocation()
  const isLanding = location.pathname === '/'

  return (
    <div className="flex h-screen bg-trader-950 bg-grid overflow-hidden font-futuristic">
      <ParticleBackground count={isLanding ? 80 : 40} />
      <div className="noise-overlay" />
      <div className="scan-line" />
      <div className="ambient-light-2" />
      {!isLanding && <Sidebar />}
      <div className="flex-1 flex flex-col overflow-hidden relative z-10">
        <Header minimal={isLanding} />
        <main className="flex-1 overflow-y-auto px-8 py-6">
          <ErrorBoundary>
            <AnimatePresence mode="wait">
              <Routes location={location} key={location.pathname}>
                <Route path="/" element={<PageTransition><Landing /></PageTransition>} />
                <Route path="/overview" element={<PageTransition><Overview /></PageTransition>} />
                <Route path="/ab-test" element={<PageTransition><ABTest /></PageTransition>} />
                <Route path="/paper" element={<PageTransition><ABTest /></PageTransition>} />
                <Route path="/strategies" element={<PageTransition><Strategies /></PageTransition>} />
                <Route path="/markets" element={<PageTransition><Markets /></PageTransition>} />
                <Route path="/portfolio" element={<PageTransition><Portfolio /></PageTransition>} />
                <Route path="/backtest" element={<PageTransition><Backtest /></PageTransition>} />
              </Routes>
            </AnimatePresence>
          </ErrorBoundary>
        </main>
      </div>
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'rgba(18, 18, 26, 0.95)',
            border: '1px solid rgba(255,255,255,0.06)',
            color: '#fff',
            backdropFilter: 'blur(20px)',
            fontFamily: 'Space Grotesk, system-ui, sans-serif',
            fontSize: '13px',
          },
        }}
        theme="dark"
      />
    </div>
  )
}

function App() {
  return (
    <MultiAccountProvider>
      <TradingProvider>
        <AppLayout />
      </TradingProvider>
    </MultiAccountProvider>
  )
}

export default App
