/**
 * Strategy Comparison Dashboard Component
 * Real-time A/B testing visualization for multi-account trading
 */

import React, { useState, useEffect } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

const COLORS = {
  aggressive: '#ef4444',    // Red
  conservative: '#3b82f6',  // Blue
  win: '#22c55e',
  loss: '#ef4444',
  neutral: '#6b7280'
};

const StrategyComparisonDashboard = ({ apiEndpoint = 'http://localhost:3001/api' }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedTimeframe, setSelectedTimeframe] = useState('1d');
  const [autoRefresh, setAutoRefresh] = useState(true);

  useEffect(() => {
    fetchData();
    let interval;
    if (autoRefresh) {
      interval = setInterval(fetchData, 5000);
    }
    return () => clearInterval(interval);
  }, [autoRefresh, selectedTimeframe]);

  const fetchData = async () => {
    try {
      const response = await fetch(`${apiEndpoint}/multi-account/comparison`);
      if (!response.ok) throw new Error('Failed to fetch data');
      const result = await response.json();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900 text-white">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p>Loading comparison data...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900 text-white">
        <div className="text-center text-red-400">
          <p className="text-xl mb-2">Error loading data</p>
          <p className="text-sm">{error}</p>
          <button 
            onClick={fetchData}
            className="mt-4 px-4 py-2 bg-blue-600 rounded hover:bg-blue-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { aggressive, conservative, comparison, timestamp } = data;

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      {/* Header */}
      <div className="mb-8">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
              A/B Strategy Testing Dashboard
            </h1>
            <p className="text-gray-400 mt-1">
              Aggressive vs Conservative • Last updated: {new Date(timestamp).toLocaleTimeString()}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <select 
              value={selectedTimeframe}
              onChange={(e) => setSelectedTimeframe(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-3 py-2"
            >
              <option value="1d">1 Day</option>
              <option value="7d">7 Days</option>
              <option value="30d">30 Days</option>
              <option value="all">All Time</option>
            </select>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="rounded"
              />
              <span className="text-sm">Auto-refresh</span>
            </label>
          </div>
        </div>
      </div>

      {/* Winner Banner */}
      {comparison.overallWinner && (
        <div className={`mb-6 p-4 rounded-lg ${
          comparison.overallWinner.winner === 'aggressive' ? 'bg-red-900/30 border border-red-500/30' :
          comparison.overallWinner.winner === 'conservative' ? 'bg-blue-900/30 border border-blue-500/30' :
          'bg-gray-800 border border-gray-700'
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-2xl">
                {comparison.overallWinner.winner === 'aggressive' ? '🏆' :
                 comparison.overallWinner.winner === 'conservative' ? '🏆' : '⚖️'}
              </span>
              <div>
                <p className="font-semibold">
                  {comparison.overallWinner.winner === 'aggressive' ? 'Aggressive Strategy Leading' :
                   comparison.overallWinner.winner === 'conservative' ? 'Conservative Strategy Leading' :
                   'Strategies Tied'}
                </p>
                <p className="text-sm text-gray-400">
                  Score: {comparison.overallWinner.score} • {comparison.keyInsights[0] || 'Performance within expected range'}
                </p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-sm text-gray-400">Combined Value</p>
              <p className="text-2xl font-bold text-green-400">
                ${(aggressive.totalValue + conservative.totalValue).toFixed(2)}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Key Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <MetricCard
          title="Total Return"
          aggressive={aggressive.totalReturn}
          conservative={conservative.totalReturn}
          suffix="%"
          format={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`}
          colorize={true}
        />
        <MetricCard
          title="Win Rate"
          aggressive={parseFloat(aggressive.winRate)}
          conservative={parseFloat(conservative.winRate)}
          suffix="%"
          format={(v) => `${v.toFixed(1)}%`}
        />
        <MetricCard
          title="Total Trades"
          aggressive={aggressive.totalTrades}
          conservative={conservative.totalTrades}
        />
        <MetricCard
          title="Max Drawdown"
          aggressive={parseFloat(aggressive.maxDrawdown)}
          conservative={parseFloat(conservative.maxDrawdown)}
          suffix="%"
          format={(v) => `${v.toFixed(2)}%`}
          inverse={true}
        />
      </div>

      {/* Account Details */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Aggressive Account */}
        <AccountCard
          title="Aggressive Account"
          subtitle="High frequency • Moderate edge (3%+) • $500 max"
          color="red"
          data={aggressive}
          strategies={['cross-market', 'scalping', 'whale-shadow', 'resolution-arb']}
        />

        {/* Conservative Account */}
        <AccountCard
          title="Conservative Account"
          subtitle="Quality focus • High edge (8%+) • $200 max"
          color="blue"
          data={conservative}
          strategies={['temporal-arb', 'correlation', 'kelly', 'flash-scout']}
        />
      </div>

      {/* Comparison Table */}
      <div className="bg-gray-800 rounded-lg p-6 mb-8">
        <h3 className="text-xl font-semibold mb-4">Side-by-Side Comparison</h3>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-700">
                <th className="text-left py-3 text-gray-400 font-medium">Metric</th>
                <th className="text-center py-3 text-red-400 font-medium">Aggressive</th>
                <th className="text-center py-3 text-blue-400 font-medium">Conservative</th>
                <th className="text-center py-3 text-gray-400 font-medium">Difference</th>
                <th className="text-center py-3 text-gray-400 font-medium">Winner</th>
              </tr>
            </thead>
            <tbody>
              {comparison.metrics.map((metric, idx) => (
                <tr key={idx} className="border-b border-gray-700/50">
                  <td className="py-3">{metric.metric}</td>
                  <td className="text-center py-3 font-mono">{metric.aggressive}</td>
                  <td className="text-center py-3 font-mono">{metric.conservative}</td>
                  <td className="text-center py-3 font-mono text-gray-400">{metric.difference}</td>
                  <td className="text-center py-3">
                    {metric.winner && (
                      <span className={`px-2 py-1 rounded text-xs ${
                        metric.winner === 'aggressive' ? 'bg-red-500/20 text-red-400' :
                        metric.winner === 'conservative' ? 'bg-blue-500/20 text-blue-400' :
                        'bg-gray-700 text-gray-400'
                      }`}>
                        {metric.winner === 'aggressive' ? 'Agg' :
                         metric.winner === 'conservative' ? 'Con' : 'Tie'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Strategy Performance */}
      <div className="bg-gray-800 rounded-lg p-6 mb-8">
        <h3 className="text-xl font-semibold mb-4">Strategy Performance by Account</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <StrategyTable 
            title="Aggressive Strategies" 
            color="red"
            strategies={aggressive.strategyPerformance || {}} 
          />
          <StrategyTable 
            title="Conservative Strategies" 
            color="blue"
            strategies={conservative.strategyPerformance || {}} 
          />
        </div>
      </div>

      {/* Key Insights */}
      {comparison.keyInsights.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-6">
          <h3 className="text-xl font-semibold mb-4">Key Insights</h3>
          <div className="space-y-2">
            {comparison.keyInsights.map((insight, idx) => (
              <div key={idx} className="flex items-center gap-3 text-gray-300">
                <span className="text-yellow-400">💡</span>
                <span>{insight}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// Helper Components

const MetricCard = ({ title, aggressive, conservative, suffix = '', format = (v) => v, colorize = false, inverse = false }) => {
  const determineWinner = () => {
    if (inverse) {
      return aggressive < conservative ? 'aggressive' : conservative < aggressive ? 'conservative' : 'tie';
    }
    return aggressive > conservative ? 'aggressive' : conservative > aggressive ? 'conservative' : 'tie';
  };

  const winner = determineWinner();
  const diff = aggressive - conservative;

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <h4 className="text-gray-400 text-sm mb-2">{title}</h4>
      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <span className="text-red-400 text-sm">Aggressive</span>
          <span className={`font-mono font-semibold ${colorize && aggressive >= 0 ? 'text-green-400' : colorize ? 'text-red-400' : 'text-white'}`}>
            {format(aggressive)}{suffix}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-blue-400 text-sm">Conservative</span>
          <span className={`font-mono font-semibold ${colorize && conservative >= 0 ? 'text-green-400' : colorize ? 'text-red-400' : 'text-white'}`}>
            {format(conservative)}{suffix}
          </span>
        </div>
        <div className="pt-2 border-t border-gray-700 flex justify-between items-center">
          <span className="text-xs text-gray-500">Difference</span>
          <span className={`text-xs font-mono ${winner === 'aggressive' ? 'text-red-400' : winner === 'conservative' ? 'text-blue-400' : 'text-gray-400'}`}>
            {diff > 0 ? '+' : ''}{format(diff)}{suffix}
          </span>
        </div>
      </div>
    </div>
  );
};

const AccountCard = ({ title, subtitle, color, data, strategies }) => {
  const colorClasses = {
    red: 'border-red-500/30 bg-red-900/10',
    blue: 'border-blue-500/30 bg-blue-900/10'
  };

  return (
    <div className={`rounded-lg p-6 border ${colorClasses[color]}`}>
      <div className="mb-4">
        <h3 className="text-xl font-semibold">{title}</h3>
        <p className="text-sm text-gray-400">{subtitle}</p>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <p className="text-gray-400 text-sm">Current Value</p>
          <p className="text-2xl font-bold">${data.totalValue?.toFixed(2) || '0.00'}</p>
        </div>
        <div>
          <p className="text-gray-400 text-sm">Cash Available</p>
          <p className="text-2xl font-bold">${data.cash?.toFixed(2) || '0.00'}</p>
        </div>
        <div>
          <p className="text-gray-400 text-sm">Open Positions</p>
          <p className="text-2xl font-bold">{data.openPositions || 0}</p>
        </div>
        <div>
          <p className="text-gray-400 text-sm">Today's Trades</p>
          <p className="text-2xl font-bold">{data.dailyTrades || 0}</p>
        </div>
      </div>

      <div className="mt-4">
        <p className="text-gray-400 text-sm mb-2">Active Strategies</p>
        <div className="flex flex-wrap gap-2">
          {strategies.map((strategy) => (
            <span key={strategy} className="px-2 py-1 bg-gray-700 rounded text-xs">
              {strategy}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};

const StrategyTable = ({ title, color, strategies }) => {
  const entries = Object.entries(strategies);
  
  if (entries.length === 0) {
    return (
      <div>
        <h4 className={`font-semibold mb-2 ${color === 'red' ? 'text-red-400' : 'text-blue-400'}`}>{title}</h4>
        <p className="text-gray-500 text-sm">No trades recorded yet</p>
      </div>
    );
  }

  return (
    <div>
      <h4 className={`font-semibold mb-2 ${color === 'red' ? 'text-red-400' : 'text-blue-400'}`}>{title}</h4>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-700">
            <th className="text-left py-2">Strategy</th>
            <th className="text-right py-2">Trades</th>
            <th className="text-right py-2">Wins</th>
            <th className="text-right py-2">P&L</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([name, stats]) => (
            <tr key={name} className="border-b border-gray-700/30">
              <td className="py-2">{name}</td>
              <td className="text-right py-2">{stats.trades}</td>
              <td className="text-right py-2">{stats.wins}</td>
              <td className={`text-right py-2 ${stats.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                ${stats.pnl?.toFixed(2) || '0.00'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default StrategyComparisonDashboard;
