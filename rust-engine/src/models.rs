use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Price {
    pub symbol: String,
    pub price: f64,
    pub timestamp: DateTime<Utc>,
    pub source: PriceSource,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum PriceSource {
    Binance,
    CryptoQuant,
    TradingView,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CryptoContract {
    pub token_id: String,
    pub condition_id: String,
    pub question: String,
    pub asset: CryptoAsset,
    pub direction: Direction,
    pub strike_price: f64,
    pub expiry: DateTime<Utc>,
    pub expiry_minutes: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum CryptoAsset {
    BTC,
    ETH,
    SOL,
}

impl CryptoAsset {
    pub fn binance_symbol(&self) -> &'static str {
        match self {
            Self::BTC => "btcusdt",
            Self::ETH => "ethusdt",
            Self::SOL => "solusdt",
        }
    }

    pub fn from_str_loose(s: &str) -> Option<Self> {
        let lower = s.to_lowercase();
        if lower.contains("btc") || lower.contains("bitcoin") {
            Some(Self::BTC)
        } else if lower.contains("eth") || lower.contains("ethereum") {
            Some(Self::ETH)
        } else if lower.contains("sol") || lower.contains("solana") {
            Some(Self::SOL)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Above,
    Below,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderbookState {
    pub token_id: String,
    pub best_bid: f64,
    pub best_ask: f64,
    pub bid_size: f64,
    pub ask_size: f64,
    pub mid_price: f64,
    pub spread: f64,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Signal {
    pub id: String,
    pub contract: CryptoContract,
    pub side: TradeSide,
    pub implied_prob: f64,
    pub actual_prob: f64,
    pub divergence: f64,
    pub confidence: f64,
    pub suggested_size: f64,
    pub timestamp: DateTime<Utc>,
    pub sources_agreeing: u8,
    pub trend_state: TrendState,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TradeSide {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TrendState {
    StrongUp,
    WeakUp,
    Sideways,
    WeakDown,
    StrongDown,
}

impl TrendState {
    pub fn is_trending(&self) -> bool {
        matches!(self, Self::StrongUp | Self::StrongDown)
    }

    /// Base divergence threshold. May be adjusted upward by book depth in detector.
    /// Tuned from 135k trade analysis: raised all thresholds to eliminate <5% edge bleed.
    /// Strong trends 18→22%, Weak 20→25%, Sideways 25→30%.
    pub fn divergence_threshold(&self) -> f64 {
        match self {
            Self::StrongUp | Self::StrongDown => 0.22,
            Self::WeakUp | Self::WeakDown => 0.25,
            Self::Sideways => 0.30,
        }
    }

    /// Position size multiplier by trend. Increased from analysis showing
    /// bigger positions ($50-100) have 65% WR vs 41% for <$10.
    pub fn position_size_multiplier(&self) -> f64 {
        match self {
            Self::StrongUp | Self::StrongDown => 2.0,
            Self::WeakUp | Self::WeakDown => 1.2,
            Self::Sideways => 0.7,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trade {
    pub id: String,
    pub signal_id: String,
    pub contract_token_id: String,
    pub asset: CryptoAsset,
    pub side: TradeSide,
    pub price: f64,
    pub size: f64,
    pub cost: f64,
    pub divergence_at_entry: f64,
    pub status: TradeStatus,
    pub submitted_at: DateTime<Utc>,
    pub filled_at: Option<DateTime<Utc>>,
    pub pnl: Option<f64>,
    pub exit_price: Option<f64>,
    pub fees_paid: Option<f64>,
    pub fill_ratio: Option<f64>,
    pub hold_ms: Option<u64>,
    pub entry_slippage_bps: Option<f64>,
    pub exit_slippage_bps: Option<f64>,
    pub shadow_entry_price: Option<f64>,
    pub shadow_exit_price: Option<f64>,
    pub shadow_pnl: Option<f64>,
    pub shadow_slippage_bps: Option<f64>,
    /// Microseconds from signal timestamp to order submission
    pub signal_latency_us: Option<u64>,
    /// Microseconds for the full execution (submission to fill/response)
    pub execution_latency_us: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TradeStatus {
    Pending,
    Filled,
    PartialFill,
    Cancelled,
    Rejected,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RiskState {
    pub daily_pnl: f64,
    pub daily_trades: u32,
    pub open_positions: u32,
    pub consecutive_losses: std::collections::HashMap<String, u32>,
    pub last_trade_time: std::collections::HashMap<String, DateTime<Utc>>,
    pub halted: bool,
    pub halt_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineStatus {
    pub running: bool,
    pub paper_mode: bool,
    pub uptime_secs: u64,
    pub feeds: FeedStatus,
    pub risk: RiskState,
    pub signals_today: u32,
    pub trades_today: u32,
    pub daily_pnl: f64,
}

// ── Correlated Market Arbitrage Types ──

/// Defines the logical relationship between two Polymarket markets.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Relationship {
    /// Market A is a subset of Market B.
    /// e.g. "Win primary" is a subset of "Win presidency" — P(A) <= P(B).
    Subset,
    /// Market A is a superset of Market B. P(A) >= P(B).
    Superset,
    /// Both markets cannot be true simultaneously. P(A) + P(B) <= 1.
    MutuallyExclusive,
    /// A and B are complementary — P(A) + P(B) >= 1.
    Complementary,
}

/// A registered pair of correlated Polymarket markets.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorrelatedPair {
    pub id: String,
    pub market_a_token: String,
    pub market_b_token: String,
    pub relationship: Relationship,
    /// Human-readable label, e.g. "Trump primary vs presidency"
    pub label: Option<String>,
}

/// Signal emitted when a correlated pair violates its logical constraint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorrelationSignal {
    pub id: String,
    pub pair: CorrelatedPair,
    /// Price of market A (YES mid)
    pub price_a: f64,
    /// Price of market B (YES mid)
    pub price_b: f64,
    /// Raw violation magnitude (always positive when a violation exists)
    pub violation: f64,
    /// Net edge after fees (violation - fee estimate)
    pub net_edge: f64,
    pub confidence: f64,
    /// Which token to BUY (the underpriced side)
    pub buy_token: String,
    /// Which token to SELL/short (the overpriced side)
    pub sell_token: String,
    pub suggested_size: f64,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FeedStatus {
    pub binance_connected: bool,
    pub binance_last_price: Option<f64>,
    pub polymarket_connected: bool,
    pub polymarket_books: u32,
    pub cryptoquant_connected: bool,
    pub tradingview_connected: bool,
}

// --- Event-driven update types ---

/// Emitted by BinanceFeed when a price changes by more than the minimum threshold (0.01%).
#[derive(Debug, Clone)]
pub struct PriceUpdate {
    pub symbol: String,
    pub asset: CryptoAsset,
    pub price: f64,
    pub prev_price: f64,
    pub change_pct: f64,
    pub timestamp: DateTime<Utc>,
}

/// Emitted by PolymarketFeed when an orderbook changes.
#[derive(Debug, Clone)]
pub struct BookUpdate {
    pub token_id: String,
    pub mid_price: f64,
    pub spread: f64,
    pub best_bid: f64,
    pub best_ask: f64,
    pub timestamp: DateTime<Utc>,
}

/// Pre-computed probability for a contract, cached until underlying price changes.
#[derive(Debug, Clone)]
pub struct CachedProb {
    pub token_id: String,
    pub asset: CryptoAsset,
    pub prob: f64,
    pub vol: f64,
    pub binance_price: f64,
    pub strike: f64,
    pub direction: Direction,
    pub secs_to_expiry: f64,
    pub timestamp: DateTime<Utc>,
}
