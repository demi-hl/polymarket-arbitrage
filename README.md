# Polymarket Multi-Account Paper Trading System

A/B testing framework for comparing aggressive vs conservative trading strategies on Polymarket.

## 🚀 Quick Start

```bash
# Start both accounts trading
node polymarket.js multi-start

# Run for 7 days
node polymarket.js multi-start --days 7

# View comparison
node polymarket.js compare

# Run optimizer
node polymarket.js optimize

# Export data
node polymarket.js export --format csv
```

## 📊 Account Configuration

### Account A: "Aggressive"
- **Virtual Balance**: $10,000
- **Min Edge**: 3%
- **Max Position**: $500
- **Target**: 20+ trades/day
- **Strategies**: Cross-market, Scalping, Whale Shadow, Resolution

### Account B: "Conservative"
- **Virtual Balance**: $10,000
- **Min Edge**: 8%
- **Max Position**: $200
- **Target**: 5-10 trades/day
- **Strategies**: Temporal, Correlation, Kelly Criterion, Flash Scout

## 📈 Volume Trading Engine

Position sizes scale with edge strength:

| Edge | Aggressive Position | Conservative Position |
|------|--------------------|------------------------|
| 3-5% | $100 | - |
| 5-8% | $200 | - |
| 8-10% | $400 | $100 |
| 10-12% | $400 | $150 |
| 12-15% | $500 | $200 |
| 15%+ | $500 (max) | $200 (max) |

## 🧠 Features

### 1. Multi-Account Manager (`accounts/manager.js`)
- Manages multiple paper trading accounts
- Tracks individual and combined P&L
- Handles risk limits per account
- Strategy performance tracking

### 2. Volume Trading Engine (`trading/volume.js`)
- Dynamic position sizing based on edge
- Realistic slippage simulation
- Liquidity-adjusted sizing
- Kelly Criterion optimization

### 3. Strategy Comparison Dashboard (`dashboard/comparison.jsx`)
- Real-time side-by-side comparison
- Performance metrics visualization
- Strategy effectiveness analysis
- Winner determination algorithm

### 4. Auto-Optimizer (`optimizer/engine.js`)
- Automatic edge threshold adjustment
- Position size optimization
- Strategy migration (promote/demote)
- Risk management tuning

### 5. Combined Reporting (`reports/combined.js`)
- Export to JSON/CSV
- Comprehensive performance analysis
- Risk metrics (VaR, drawdown)
- Strategic recommendations

## 🎮 CLI Commands

### `node polymarket.js multi-start`
Starts paper trading on both accounts simultaneously.

Options:
- `--days <n>`: Run for n days (default: 1)
- `--interval <s>`: Scan interval in seconds (default: 30)
- `--no-optimizer`: Disable auto-optimizer

### `node polymarket.js compare`
View detailed side-by-side comparison of both accounts.

Options:
- `--json`: Output as JSON

### `node polymarket.js optimize`
Run auto-optimizer to analyze performance and suggest improvements.

Options:
- `--dry-run`: Show recommendations without applying

### `node polymarket.js export`
Export all trading data for external analysis.

Options:
- `--format <json|csv>`: Export format (default: json)

### `node polymarket.js multi-reset`
Reset one or both accounts to initial $10,000 balance.

Options:
- `--account <id>`: Reset specific account (aggressive, conservative, both)

## 📁 File Structure

```
polymarket-arbitrage-bot/
├── accounts/
│   └── manager.js          # Multi-account management
├── trading/
│   └── volume.js           # Volume-based position sizing
├── dashboard/
│   └── comparison.jsx      # React comparison dashboard
├── optimizer/
│   └── engine.js           # Auto-optimization engine
├── reports/
│   └── combined.js         # Combined reporting
├── config/
│   └── multi-account.js    # Configuration
└── polymarket.js           # Main CLI with multi-account commands
```

## 🔧 Configuration

Edit `config/multi-account.js` to customize:

- Virtual balances
- Edge thresholds
- Position sizing rules
- Strategy assignments
- Risk limits
- Optimization settings

## 📊 Performance Metrics

The system tracks:

- Total Return (%)
- Win Rate (%)
- Sharpe Ratio
- Max Drawdown (%)
- Profit Factor
- Average Trade Size
- Total Volume
- Strategy-specific P&L

## 🎯 Optimization Rules

The auto-optimizer will:

1. **Promote strategies** with >60% win rate after 10+ trades
2. **Demote strategies** with <40% win rate after 10+ trades
3. **Adjust edge thresholds** based on win rate performance
4. **Modify position sizes** based on profit factor
5. **Tighten risk limits** if drawdown exceeds thresholds

## 📝 Data Storage

All data is stored in `data/multi-account/`:

- `portfolio-aggressive.json`
- `portfolio-conservative.json`
- `optimization-history.json`
- `multi-account-report-YYYY-MM-DD.{json,csv}`

## 🔄 A/B Testing Methodology

1. Both accounts receive identical market data
2. Each account applies its own filters and strategies
3. Trades are executed independently
4. Performance is tracked and compared
5. Optimizer suggests improvements
6. Configuration can be updated based on results

## 🚨 Risk Management

Each account has independent risk controls:

- Max drawdown limits (15% aggressive, 10% conservative)
- Daily loss limits ($500 aggressive, $300 conservative)
- Position concentration limits
- Daily trade count limits

## 💡 Tips

1. Run for at least 7 days for meaningful comparison
2. Monitor the optimizer recommendations weekly
3. Export data regularly for external analysis
4. Review strategy performance to identify what works
5. Adjust edge thresholds based on market conditions

## 📞 Support

For issues or questions, check:
- `node polymarket.js compare --json` for detailed data
- `data/multi-account/` for trade history
- Console logs for real-time trading activity
