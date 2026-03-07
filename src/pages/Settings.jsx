import React, { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import { StaggerContainer, StaggerItem } from '../components/PageTransition'
import { Settings as SettingsIcon } from '../components/Icons'
import { useWallet } from '../context/WalletContext'

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
  const { jwt } = useWallet()
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const authHeaders = jwt ? { Authorization: `Bearer ${jwt}` } : {}

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/settings', { headers: authHeaders })
        const json = await res.json()
        if (json.success && json.data) {
          setSettings(prev => deepMerge(prev, json.data))
        }
      } catch {} finally { setLoading(false) }
    }
    load()
  }, [jwt])

  const save = useCallback(async (newSettings) => {
    setSaving(true)
    setSaved(false)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(newSettings),
      })
      const json = await res.json()
      if (json.success) {
        setSettings(newSettings)
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      }
    } catch {} finally { setSaving(false) }
  }, [jwt])

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

function GasMonitor() {
  const [gas, setGas] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchGas = async () => {
      try {
        const res = await fetch('/api/gas')
        const json = await res.json()
        if (json.success) setGas(json.data)
      } catch {} finally { setLoading(false) }
    }
    fetchGas()
    const interval = setInterval(fetchGas, 15000)
    return () => clearInterval(interval)
  }, [])

  if (loading) return <div className="shimmer rounded-xl h-40" />

  const tiers = gas ? [gas.slow, gas.standard, gas.fast, gas.recommended] : []
  const tierColors = ['#6b7280', '#f59e0b', '#10b981', '#00d4ff']

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: gas ? '#10b981' : '#6b7280', boxShadow: gas ? '0 0 8px rgba(16,185,129,0.5)' : 'none' }} />
          <span className="text-xs text-gray-400">Polygon Network</span>
        </div>
        {gas && (
          <span className="text-[10px] font-mono text-gray-600">
            Base: {gas.baseFee} gwei
          </span>
        )}
      </div>

      {gas ? (
        <div className="grid grid-cols-2 gap-2">
          {tiers.map((tier, i) => (
            <div
              key={tier.label}
              className="rounded-lg p-3 relative overflow-hidden group"
              style={{
                background: tier.label === 'MEV Protection' ? 'rgba(0,212,255,0.06)' : 'rgba(255,255,255,0.02)',
                border: `1px solid ${tier.label === 'MEV Protection' ? 'rgba(0,212,255,0.15)' : 'rgba(255,255,255,0.04)'}`,
              }}
            >
              <div className="flex items-center gap-1.5 mb-1.5">
                <div className="w-1.5 h-1.5 rounded-full" style={{ background: tierColors[i] }} />
                <span className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">{tier.label}</span>
              </div>
              <div className="font-mono text-sm font-medium" style={{ color: tierColors[i] }}>
                {tier.maxFee} gwei
              </div>
              <div className="text-[9px] text-gray-600 mt-0.5">
                Priority: {tier.maxPriorityFee} · {tier.time}
              </div>
              {tier.note && (
                <div className="text-[9px] text-accent/60 mt-1">{tier.note}</div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-gray-600">Unable to fetch gas prices</div>
      )}

      <div className="rounded-lg p-3" style={{ background: 'rgba(0,212,255,0.03)', border: '1px solid rgba(0,212,255,0.08)' }}>
        <p className="text-[10px] text-gray-500 leading-relaxed">
          <strong className="text-gray-400">MEV Protection:</strong> Set gas 20% above fast to ensure your CLOB orders land before competing bots.
          On Polygon, priority fee determines transaction ordering within a block.
          Higher priority = your trade executes first when exploiting price discrepancies.
        </p>
      </div>
    </div>
  )
}

function CredentialManager() {
  const { jwt } = useWallet()
  const [credStatus, setCredStatus] = useState(null)
  const [form, setForm] = useState({ privateKey: '', apiKey: '', apiSecret: '', passphrase: '' })
  const [saving, setSaving] = useState(false)
  const [showForm, setShowForm] = useState(false)

  useEffect(() => {
    if (!jwt) return
    fetch('/api/settings/credentials', { headers: { Authorization: `Bearer ${jwt}` } })
      .then(r => r.json())
      .then(j => j.success && setCredStatus(j.data))
      .catch(() => {})
  }, [jwt])

  const handleSave = async () => {
    setSaving(true)
    try {
      const body = {}
      if (form.privateKey) body.privateKey = form.privateKey
      if (form.apiKey) body.apiKey = form.apiKey
      if (form.apiSecret) body.apiSecret = form.apiSecret
      if (form.passphrase) body.passphrase = form.passphrase
      const res = await fetch('/api/settings/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify(body),
      })
      const j = await res.json()
      if (j.success) {
        setCredStatus(j.data)
        setForm({ privateKey: '', apiKey: '', apiSecret: '', passphrase: '' })
        setShowForm(false)
      }
    } catch {} finally { setSaving(false) }
  }

  const handleClear = async () => {
    const res = await fetch('/api/settings/credentials', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt}` },
    })
    const j = await res.json()
    if (j.success) setCredStatus({ hasKey: false, hasApiKey: false, hasSecret: false, hasPassphrase: false })
  }

  const allSet = credStatus && credStatus.hasKey && credStatus.hasApiKey && credStatus.hasSecret && credStatus.hasPassphrase

  return (
    <div className="space-y-3">
      {/* Status grid */}
      <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
        <p className="text-[10px] uppercase tracking-[0.15em] text-gray-600 mb-2">Credential Status</p>
        <div className="space-y-1.5">
          {[
            { key: 'hasKey', label: 'Signing Key' },
            { key: 'hasApiKey', label: 'API Key' },
            { key: 'hasSecret', label: 'API Secret' },
            { key: 'hasPassphrase', label: 'Passphrase' },
          ].map(cred => (
            <div key={cred.key} className="flex items-center justify-between">
              <span className="text-xs text-gray-500">{cred.label}</span>
              <span className={`text-[10px] font-mono ${credStatus?.[cred.key] ? 'text-emerald-400' : 'text-gray-700'}`}>
                {credStatus?.[cred.key] ? '● SET' : '○ NOT SET'}
              </span>
            </div>
          ))}
        </div>
        {allSet && (
          <div className="mt-2 pt-2 border-t border-white/5">
            <span className="text-[10px] font-mono text-emerald-400">✓ Ready for live trading</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-3 py-1.5 text-xs rounded-md transition-all"
          style={{ background: 'rgba(0,212,255,0.1)', border: '1px solid rgba(0,212,255,0.2)', color: '#00d4ff' }}
        >
          {showForm ? 'Cancel' : allSet ? 'Update Credentials' : 'Add Credentials'}
        </button>
        {credStatus && (credStatus.hasKey || credStatus.hasApiKey) && (
          <button
            onClick={handleClear}
            className="px-3 py-1.5 text-xs rounded-md transition-all text-red-400"
            style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.15)' }}
          >
            Clear All
          </button>
        )}
      </div>

      {/* Input form */}
      {showForm && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="space-y-2.5 rounded-lg p-3"
          style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          {[
            { key: 'privateKey', label: 'Private Key (hex)', placeholder: '0x...' },
            { key: 'apiKey', label: 'API Key', placeholder: 'Your CLOB API key' },
            { key: 'apiSecret', label: 'API Secret', placeholder: 'HMAC secret' },
            { key: 'passphrase', label: 'Passphrase', placeholder: 'API passphrase' },
          ].map(field => (
            <div key={field.key}>
              <label className="text-[10px] uppercase tracking-[0.15em] text-gray-600 mb-1 block">{field.label}</label>
              <input
                type="password"
                value={form[field.key]}
                onChange={(e) => setForm(prev => ({ ...prev, [field.key]: e.target.value }))}
                placeholder={field.placeholder}
                className="w-full px-3 py-1.5 rounded-md text-xs font-mono text-white/80 placeholder-gray-700 focus:outline-none focus:ring-1 focus:ring-accent/30"
                style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)' }}
              />
            </div>
          ))}
          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full py-2 rounded-md text-xs font-medium transition-all"
            style={{
              background: saving ? 'rgba(255,255,255,0.05)' : 'rgba(0,212,255,0.15)',
              border: '1px solid rgba(0,212,255,0.25)',
              color: '#00d4ff',
            }}
          >
            {saving ? 'Encrypting & Saving...' : 'Save Credentials (AES-256-GCM)'}
          </button>
          <p className="text-[10px] text-gray-600 leading-relaxed">
            Credentials are encrypted per-user and stored locally. They never leave this server.
          </p>
        </motion.div>
      )}
    </div>
  )
}

export default function Settings() {
  const { jwt } = useWallet()
  const { settings, setSettings, save, loading, saving, saved } = useSettings()
  const [liveStatus, setLiveStatus] = useState(null)

  useEffect(() => {
    const headers = jwt ? { Authorization: `Bearer ${jwt}` } : {}
    fetch('/api/settings/live-status', { headers })
      .then(r => r.json())
      .then(j => j.success && setLiveStatus(j.data))
      .catch(() => {})
  }, [jwt])

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
            Position sizing · Risk management · Gas & MEV · Trading mode
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

        {/* Gas / MEV Monitor */}
        <SettingCard title="Gas & MEV Monitor" description="Live Polygon gas prices — set priority to front-run competing bots">
          <GasMonitor />
        </SettingCard>

        {/* CLOB Credentials (per-user, encrypted) */}
        <SettingCard title="CLOB Credentials" description="Your Polymarket API keys — encrypted per-user, never shared">
          <CredentialManager />
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

          <div className="rounded-lg p-3" style={{ background: 'rgba(0,212,255,0.03)', border: '1px solid rgba(0,212,255,0.08)' }}>
            <p className="text-xs text-gray-400 leading-relaxed">
              Add your CLOB credentials above, then switch to live mode.
              The bot uses the <strong className="text-gray-300">operator model</strong> — it signs transactions on your behalf.
              Credentials are encrypted with AES-256-GCM and stored per-user.
            </p>
          </div>
        </SettingCard>
      </StaggerContainer>
    </div>
  )
}
