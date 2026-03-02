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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectionConfig {
    pub base_threshold: f64,
    pub trending_threshold: f64,
    pub sideways_threshold: f64,
    pub min_sources_agree: u8,
    pub priority_expiry_minutes: Vec<u32>,
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
            },
            detection: DetectionConfig {
                base_threshold: 0.003,
                trending_threshold: 0.002,
                sideways_threshold: 0.005,
                min_sources_agree: 1,
                priority_expiry_minutes: vec![15, 60, 240],
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

        config
    }
}
