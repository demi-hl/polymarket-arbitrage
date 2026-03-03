use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub paper_mode: bool,
    pub api_port: u16,

    pub polymarket_api_key: Option<String>,
    pub polymarket_api_secret: Option<String>,
    pub polymarket_api_passphrase: Option<String>,
    pub private_key: Option<String>,

    pub risk: RiskConfig,
    pub detection: DetectionConfig,
    pub paper: PaperSimConfig,

    pub binance_ws_url: String,
    pub polymarket_ws_url: String,
    pub polymarket_clob_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskConfig {
    pub max_per_trade_pct: f64,
    pub daily_loss_cap_pct: f64,
    pub capital: f64,
    pub max_concurrent_positions: u32,
    pub cooldown_per_market_secs: u64,
    pub order_timeout_secs: u64,
    pub consecutive_loss_pause: u32,
    pub consecutive_loss_pause_secs: u64,
    pub trending_size_pct: f64,
    pub sideways_size_pct: f64,
    pub min_trade_size: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectionConfig {
    pub base_threshold: f64,
    pub trending_threshold: f64,
    pub sideways_threshold: f64,
    pub min_sources_agree: u8,
    pub priority_expiry_minutes: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaperSimConfig {
    pub entry_fee_bps: f64,
    pub exit_fee_bps: f64,
    pub base_spread_bps: f64,
    pub max_spread_bps: f64,
    pub base_slippage_bps: f64,
    pub slippage_jitter_bps: f64,
    pub latency_impact_bps_per_100ms: f64,
    pub partial_fill_probability: f64,
    pub min_partial_fill_ratio: f64,
    pub min_fill_to_execute_ratio: f64,
    pub min_hold_ms: u64,
    pub max_hold_ms: u64,
    pub min_convergence_ratio: f64,
    pub max_convergence_ratio: f64,
    pub noise_std_ratio: f64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            paper_mode: true,
            api_port: 8900,
            polymarket_api_key: None,
            polymarket_api_secret: None,
            polymarket_api_passphrase: None,
            private_key: None,
            risk: RiskConfig {
                max_per_trade_pct: 0.005,
                daily_loss_cap_pct: 0.02,
                capital: 10_000.0,
                max_concurrent_positions: 5,
                cooldown_per_market_secs: 30,
                order_timeout_secs: 5,
                consecutive_loss_pause: 3,
                consecutive_loss_pause_secs: 600,
                trending_size_pct: 0.008,
                sideways_size_pct: 0.003,
                min_trade_size: 10.0,
            },
            detection: DetectionConfig {
                base_threshold: 0.20,
                trending_threshold: 0.18,
                sideways_threshold: 0.25,
                min_sources_agree: 1,
                priority_expiry_minutes: vec![15, 60, 240],
            },
            paper: PaperSimConfig {
                entry_fee_bps: 50.0,
                exit_fee_bps: 50.0,
                base_spread_bps: 12.0,
                max_spread_bps: 70.0,
                base_slippage_bps: 6.0,
                slippage_jitter_bps: 4.0,
                latency_impact_bps_per_100ms: 1.5,
                partial_fill_probability: 0.12,
                min_partial_fill_ratio: 0.55,
                min_fill_to_execute_ratio: 0.35,
                min_hold_ms: 800,
                max_hold_ms: 6500,
                min_convergence_ratio: -0.30,
                max_convergence_ratio: 0.85,
                noise_std_ratio: 0.35,
            },
            binance_ws_url: "wss://stream.binance.com:9443/stream?streams=btcusdt@ticker/ethusdt@ticker/solusdt@ticker".into(),
            polymarket_ws_url: "wss://ws-subscriptions-clob.polymarket.com/ws/market".into(),
            polymarket_clob_url: "https://clob.polymarket.com".into(),
        }
    }
}

impl Config {
    pub fn from_env() -> Self {
        let mut config = Self::default();

        if let Ok(v) = std::env::var("PAPER_MODE") {
            config.paper_mode = v != "false" && v != "0";
        }
        if let Ok(v) = std::env::var("LATENCY_ENGINE_PORT") {
            if let Ok(port) = v.parse() {
                config.api_port = port;
            }
        }
        if let Ok(v) = std::env::var("POLYMARKET_KEY") {
            config.private_key = Some(v);
        }
        if let Ok(v) = std::env::var("POLYMARKET_API_KEY") {
            config.polymarket_api_key = Some(v);
        }
        if let Ok(v) = std::env::var("POLYMARKET_API_SECRET") {
            config.polymarket_api_secret = Some(v);
        }
        if let Ok(v) = std::env::var("POLYMARKET_API_PASSPHRASE") {
            config.polymarket_api_passphrase = Some(v);
        }
        if let Ok(v) = std::env::var("CAPITAL") {
            if let Ok(cap) = v.parse() {
                config.risk.capital = cap;
            }
        }
        if let Ok(v) = std::env::var("MAX_PER_TRADE_PCT") {
            if let Ok(pct) = v.parse() {
                config.risk.max_per_trade_pct = pct;
            }
        }
        if let Ok(v) = std::env::var("DAILY_LOSS_CAP_PCT") {
            if let Ok(pct) = v.parse() {
                config.risk.daily_loss_cap_pct = pct;
            }
        }
        if let Ok(v) = std::env::var("TRENDING_SIZE_PCT") {
            if let Ok(pct) = v.parse() {
                config.risk.trending_size_pct = pct;
            }
        }
        if let Ok(v) = std::env::var("SIDEWAYS_SIZE_PCT") {
            if let Ok(pct) = v.parse() {
                config.risk.sideways_size_pct = pct;
            }
        }
        if let Ok(v) = std::env::var("MIN_TRADE_SIZE") {
            if let Ok(x) = v.parse() {
                config.risk.min_trade_size = x;
            }
        }
        if let Ok(v) = std::env::var("PAPER_ENTRY_FEE_BPS") {
            if let Ok(x) = v.parse() {
                config.paper.entry_fee_bps = x;
            }
        }
        if let Ok(v) = std::env::var("PAPER_EXIT_FEE_BPS") {
            if let Ok(x) = v.parse() {
                config.paper.exit_fee_bps = x;
            }
        }
        if let Ok(v) = std::env::var("PAPER_BASE_SPREAD_BPS") {
            if let Ok(x) = v.parse() {
                config.paper.base_spread_bps = x;
            }
        }
        if let Ok(v) = std::env::var("PAPER_MAX_SPREAD_BPS") {
            if let Ok(x) = v.parse() {
                config.paper.max_spread_bps = x;
            }
        }
        if let Ok(v) = std::env::var("PAPER_BASE_SLIPPAGE_BPS") {
            if let Ok(x) = v.parse() {
                config.paper.base_slippage_bps = x;
            }
        }
        if let Ok(v) = std::env::var("PAPER_SLIPPAGE_JITTER_BPS") {
            if let Ok(x) = v.parse() {
                config.paper.slippage_jitter_bps = x;
            }
        }
        if let Ok(v) = std::env::var("PAPER_LATENCY_IMPACT_BPS_PER_100MS") {
            if let Ok(x) = v.parse() {
                config.paper.latency_impact_bps_per_100ms = x;
            }
        }
        if let Ok(v) = std::env::var("PAPER_PARTIAL_FILL_PROBABILITY") {
            if let Ok(x) = v.parse() {
                config.paper.partial_fill_probability = x;
            }
        }
        if let Ok(v) = std::env::var("PAPER_MIN_PARTIAL_FILL_RATIO") {
            if let Ok(x) = v.parse() {
                config.paper.min_partial_fill_ratio = x;
            }
        }
        if let Ok(v) = std::env::var("PAPER_MIN_FILL_TO_EXECUTE_RATIO") {
            if let Ok(x) = v.parse() {
                config.paper.min_fill_to_execute_ratio = x;
            }
        }
        if let Ok(v) = std::env::var("PAPER_MIN_HOLD_MS") {
            if let Ok(x) = v.parse() {
                config.paper.min_hold_ms = x;
            }
        }
        if let Ok(v) = std::env::var("PAPER_MAX_HOLD_MS") {
            if let Ok(x) = v.parse() {
                config.paper.max_hold_ms = x;
            }
        }
        if let Ok(v) = std::env::var("PAPER_MIN_CONVERGENCE_RATIO") {
            if let Ok(x) = v.parse() {
                config.paper.min_convergence_ratio = x;
            }
        }
        if let Ok(v) = std::env::var("PAPER_MAX_CONVERGENCE_RATIO") {
            if let Ok(x) = v.parse() {
                config.paper.max_convergence_ratio = x;
            }
        }
        if let Ok(v) = std::env::var("PAPER_NOISE_STD_RATIO") {
            if let Ok(x) = v.parse() {
                config.paper.noise_std_ratio = x;
            }
        }

        config
    }
}
