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

    pub fn divergence_threshold(&self) -> f64 {
        match self {
            Self::StrongUp | Self::StrongDown => 0.002,
            Self::WeakUp | Self::WeakDown => 0.003,
            Self::Sideways => 0.005,
        }
    }

    pub fn position_size_multiplier(&self) -> f64 {
        match self {
            Self::StrongUp | Self::StrongDown => 1.6,
            Self::WeakUp | Self::WeakDown => 1.0,
            Self::Sideways => 0.6,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FeedStatus {
    pub binance_connected: bool,
    pub binance_last_price: Option<f64>,
    pub polymarket_connected: bool,
    pub polymarket_books: u32,
    pub cryptoquant_connected: bool,
    pub tradingview_connected: bool,
}
