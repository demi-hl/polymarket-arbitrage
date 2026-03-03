import React from 'react'
import { Routes, Route, useLocation, NavLink } from 'react-router-dom'
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
import { LayoutDashboard, GitCompare, TrendingUp, Wallet, BarChart3 } from './components/Icons'

const mobileNavItems = [
  { path: '/overview', icon: LayoutDashboard, label: 'Overview' },
  { path: '/paper', icon: GitCompare, label: 'Paper' },
  { path: '/markets', icon: TrendingUp, label: 'Markets' },
  { path: '/portfolio', icon: Wallet, label: 'Portfolio' },
  { path: '/backtest', icon: BarChart3, label: 'Report' },
]

function AppLayout() {
  const location = useLocation()
  const isLanding = location.pathname === '/'

  return (
    <div className="flex h-screen bg-trader-950 bg-grid overflow-hidden font-futuristic">
      <ParticleBackground count={isLanding ? 80 : 40} />
      <div className="noise-overlay" />
      <div className="scan-line" />
      <div className="ambient-light-2" />
      {!isLanding && <div className="hidden md:block"><Sidebar /></div>}
      <div className="flex-1 flex flex-col overflow-hidden relative z-10">
        <Header minimal={isLanding} />
        <main className="flex-1 overflow-y-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6 pb-24 md:pb-6">
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
        {!isLanding && (
          <nav
            className="md:hidden fixed bottom-0 left-0 right-0 z-40 px-3 py-2"
            style={{
              background: 'rgba(10,10,18,0.94)',
              backdropFilter: 'blur(24px)',
              borderTop: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <div className="grid grid-cols-5 gap-1">
              {mobileNavItems.map(item => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={({ isActive }) => `flex flex-col items-center justify-center py-2 rounded-lg transition-colors ${isActive ? 'text-accent bg-accent/10' : 'text-gray-500'}`}
                >
                  <item.icon size={16} />
                  <span className="text-[10px] mt-1">{item.label}</span>
                </NavLink>
              ))}
            </div>
          </nav>
        )}
      </div>
      <Toaster
        position="bottom-right"
        offset={{ bottom: 80 }}
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
