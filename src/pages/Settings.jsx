import React, { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import { StaggerContainer, StaggerItem } from '../components/PageTransition'
import { Settings as SettingsIcon } from '../components/Icons'

const DEFAULT_SETTINGS = {
  positionSizing: {
    mode: 'fixed', // 'fixed' or 'percentage'
    fixedAmount: 25,
    percentageOfPortfolio: 2,
    maxPositionPerMarket: 100,
  },
  risk: {
    maxConcurrentPositions: 10,
    stopLossPercent: 15,
    takeProfitPercent: 25,
    maxDailyLoss: 500,
  },
  trading: {
    mode: 'paper', // 'paper' or 'live'
    autoExecute: true,
    minEdgePercent: 3,
    minLiquidity: 1000,
  },
}

function useSettings() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/settings')
        const json = await res.json()
        if (json.success && json.data) {
          setSettings(prev => deepMerge(prev, json.data))
        }
      } catch {} finally { setLoading(false) }
    }
    load()
  }, [])

  const save = useCallback(async (newSettings) => {
    setSaving(true)
    setSaved(false)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings),
      })
      const json = await res.json()
      if (json.success) {
        setSettings(newSettings)
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      }
    } catch {} finally { setSaving(false) }
  }, [])

  return { settings, setSettings, save, loading, saving, saved }
}

function deepMerge(target, source) {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key])
    } else {
      result[key] = source[key]
    }
  }
  return result
}

function SettingCard({ title, description, children }) {
  return (
    <StaggerItem>
      <div className="rounded-xl border border-white/[0.06] p-5 transition-all duration-300 hover:border-white/[0.10]"
        style={{ background: 'rgba(255,255,255,0.02)' }}
      >
        <div className="mb-4">
          <h3 className="text-sm font-medium text-white">{title}</h3>
          {description && <p className="text-xs text-gray-600 mt-1">{description}</p>}
        </div>
        <div className="space-y-4">
          {children}
        </div>
      </div>
    </StaggerItem>
  )
}

function SettingRow({ label, description, children }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-300">{label}</p>
        {description && <p className="text-[10px] text-gray-600 mt-0.5">{description}</p>}
      </div>
      <div className="flex-shrink-0">
        {children}
      </div>
    </div>
  )
}

function NumberInput({ value, onChange, min, max, step = 1, prefix = '', suffix = '', className = '' }) {
  return (
    <div className="relative inline-flex items-center">
      {prefix && <span className="text-xs text-gray-500 mr-1">{prefix}</span>}
      <input
        type="number"
        value={value}
        onChange={(e) => {
          let v = parseFloat(e.target.value)
          if (isNaN(v)) v = min || 0
          if (min !== undefined) v = Math.max(min, v)
          if (max !== undefined) v = Math.min(max, v)
          onChange(v)
        }}
        min={min}
        max={max}
        step={step}
        className={`w-20 px-2 py-1.5 rounded-lg text-sm font-mono text-right text-white transition-all duration-200 focus:outline-none focus:ring-1 focus:ring-accent/30 ${className}`}
        style={{
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      />
      {suffix && <span className="text-xs text-gray-500 ml-1">{suffix}</span>}
    </div>
  )
}

function Toggle({ value, onChange, labels = ['Off', 'On'] }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="relative inline-flex items-center h-7 rounded-full w-12 transition-all duration-300 focus:outline-none"
      style={{
        background: value ? 'rgba(0,212,255,0.2)' : 'rgba(255,255,255,0.06)',
        border: `1px solid ${value ? 'rgba(0,212,255,0.3)' : 'rgba(255,255,255,0.08)'}`,
      }}
    >
      <motion.div
        className="w-5 h-5 rounded-full"
        style={{
          background: value ? '#00d4ff' : 'rgba(255,255,255,0.2)',
          boxShadow: value ? '0 0 8px rgba(0,212,255,0.4)' : 'none',
        }}
        animate={{ x: value ? 22 : 3 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      />
    </button>
  )
}

function ModeSelector({ value, onChange, options }) {
  return (
    <div className="flex gap-1 p-1 rounded-lg" style={{ background: 'rgba(255,255,255,0.03)' }}>
      {options.map(opt => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
            value === opt.value
              ? 'text-white bg-white/[0.08]'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

export default function Settings() {
  const { settings, setSettings, save, loading, saving, saved } = useSettings()
  const [liveStatus, setLiveStatus] = useState(null)

  useEffect(() => {
    fetch('/api/settings/live-status')
      .then(r => r.json())
      .then(j => j.success && setLiveStatus(j.data))
      .catch(() => {})
  }, [])

  const update = (section, key, value) => {
    const newSettings = {
      ...settings,
      [section]: { ...settings[section], [key]: value },
    }
    setSettings(newSettings)
  }

  const handleSave = () => save(settings)

  if (loading) {
    return (
      <div className="space-y-8">
        <div className="shimmer rounded-2xl bg-trader-700/50 h-12 w-80" />
        <div className="grid grid-cols-2 gap-5">
          {[...Array(4)].map((_, i) => <div key={i} className="shimmer rounded-2xl bg-trader-700/50 h-48" />)}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-gradient-minimal">Settings</h2>
          <p className="text-xs text-gray-500 mt-1">
            Position sizing · Risk management · Trading mode
          </p>
        </div>
        <motion.button
          onClick={handleSave}
          disabled={saving}
          className="btn-primary px-5 py-2.5 text-sm font-medium"
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
        >
          {saving ? 'Saving...' : saved ? '✓ Saved' : 'Save Settings'}
        </motion.button>
      </div>

      <StaggerContainer className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Position Sizing */}
        <SettingCard title="Position Sizing" description="Control how much capital is allocated per trade">
          <SettingRow label="Sizing Mode" description="Fixed dollar amount or % of portfolio">
            <ModeSelector
              value={settings.positionSizing.mode}
              onChange={(v) => update('positionSizing', 'mode', v)}
              options={[
                { value: 'fixed', label: 'Fixed $' },
                { value: 'percentage', label: '% Portfolio' },
              ]}
            />
          </SettingRow>

          {settings.positionSizing.mode === 'fixed' ? (
            <SettingRow label="Amount Per Trade" description="$5 — $500">
              <NumberInput
                value={settings.positionSizing.fixedAmount}
                onChange={(v) => update('positionSizing', 'fixedAmount', v)}
                min={5} max={500} step={5}
                prefix="$"
              />
            </SettingRow>
          ) : (
            <SettingRow label="Portfolio %" description="0.5% — 10%">
              <NumberInput
                value={settings.positionSizing.percentageOfPortfolio}
                onChange={(v) => update('positionSizing', 'percentageOfPortfolio', v)}
                min={0.5} max={10} step={0.5}
                suffix="%"
              />
            </SettingRow>
          )}

          <SettingRow label="Max Per Market" description="Maximum position size in any single market">
            <NumberInput
              value={settings.positionSizing.maxPositionPerMarket}
              onChange={(v) => update('positionSizing', 'maxPositionPerMarket', v)}
              min={10} max={5000} step={10}
              prefix="$"
            />
          </SettingRow>
        </SettingCard>

        {/* Risk Management */}
        <SettingCard title="Risk Management" description="Guard rails to limit downside exposure">
          <SettingRow label="Max Concurrent Positions" description="1 — 50">
            <NumberInput
              value={settings.risk.maxConcurrentPositions}
              onChange={(v) => update('risk', 'maxConcurrentPositions', v)}
              min={1} max={50}
            />
          </SettingRow>

          <SettingRow label="Stop Loss" description="Auto-exit when position drops this %">
            <NumberInput
              value={settings.risk.stopLossPercent}
              onChange={(v) => update('risk', 'stopLossPercent', v)}
              min={1} max={50}
              suffix="%"
            />
          </SettingRow>

          <SettingRow label="Take Profit" description="Auto-exit when position gains this %">
            <NumberInput
              value={settings.risk.takeProfitPercent}
              onChange={(v) => update('risk', 'takeProfitPercent', v)}
              min={5} max={100}
              suffix="%"
            />
          </SettingRow>

          <SettingRow label="Max Daily Loss" description="Stop trading after this daily drawdown">
            <NumberInput
              value={settings.risk.maxDailyLoss}
              onChange={(v) => update('risk', 'maxDailyLoss', v)}
              min={50} max={10000} step={50}
              prefix="$"
            />
          </SettingRow>
        </SettingCard>

        {/* Trading Configuration */}
        <SettingCard title="Trading Configuration" description="Strategy execution parameters">
          <SettingRow label="Min Edge" description="Only trade when edge exceeds this %">
            <NumberInput
              value={settings.trading.minEdgePercent}
              onChange={(v) => update('trading', 'minEdgePercent', v)}
              min={0.5} max={20} step={0.5}
              suffix="%"
            />
          </SettingRow>

          <SettingRow label="Min Liquidity" description="Skip markets below this liquidity">
            <NumberInput
              value={settings.trading.minLiquidity}
              onChange={(v) => update('trading', 'minLiquidity', v)}
              min={100} max={100000} step={100}
              prefix="$"
            />
          </SettingRow>

          <SettingRow label="Auto-Execute" description="Automatically execute trades when signals fire">
            <Toggle
              value={settings.trading.autoExecute}
              onChange={(v) => update('trading', 'autoExecute', v)}
            />
          </SettingRow>
        </SettingCard>

        {/* Live Trading Status */}
        <SettingCard title="Trading Mode" description="Switch between paper and live trading">
          <SettingRow label="Mode" description={settings.trading.mode === 'live' ? 'Trading with real USDC on Polygon' : 'Simulated trades — no real funds at risk'}>
            <div className="flex items-center gap-3">
              <span className={`text-xs font-mono uppercase tracking-wider px-2.5 py-1 rounded-md ${
                settings.trading.mode === 'live'
                  ? 'text-red-400 bg-red-400/10 border border-red-400/20'
                  : 'text-emerald-400 bg-emerald-400/10 border border-emerald-400/20'
              }`}>
                {settings.trading.mode === 'live' ? '● LIVE' : '◉ PAPER'}
              </span>
            </div>
          </SettingRow>

          <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
            <p className="text-[10px] uppercase tracking-[0.15em] text-gray-600 mb-2">Credential Status</p>
            <div className="space-y-1.5">
              {[
                { key: 'POLYMARKET_KEY', label: 'Private Key' },
                { key: 'POLYMARKET_API_KEY', label: 'API Key' },
                { key: 'POLYMARKET_API_SECRET', label: 'API Secret' },
                { key: 'POLYMARKET_API_PASSPHRASE', label: 'Passphrase' },
              ].map(cred => (
                <div key={cred.key} className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">{cred.label}</span>
                  <span className={`text-[10px] font-mono ${
                    liveStatus?.credentials?.[cred.key] ? 'text-emerald-400' : 'text-gray-700'
                  }`}>
                    {liveStatus?.credentials?.[cred.key] ? '● SET' : '○ NOT SET'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg p-3" style={{ background: 'rgba(0,212,255,0.03)', border: '1px solid rgba(0,212,255,0.08)' }}>
            <p className="text-xs text-gray-400 leading-relaxed">
              To go live, set your Polymarket CLOB API credentials as environment variables in <code className="text-accent/70 font-mono text-[10px]">.env</code> and restart the engine.
              The bot uses the <strong className="text-gray-300">operator model</strong> — it signs transactions on your behalf without holding your private key in the frontend.
            </p>
          </div>
        </SettingCard>
      </StaggerContainer>
    </div>
  )
}
