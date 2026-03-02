use anyhow::Result;
use chrono::Utc;
use dashmap::DashMap;
use std::sync::Arc;
use tracing::{info, warn};

use crate::models::TrendState;

/// TradingView-sourced technical indicators for trend detection.
/// Feeds into trend-adaptive position sizing: trending markets get larger
/// positions, sideways/choppy markets get smaller.
pub struct TradingViewFeed {
    pub indicators: Arc<DashMap<String, TechnicalIndicators>>,
    pub trends: Arc<DashMap<String, TrendState>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TechnicalIndicators {
    pub symbol: String,
    pub rsi_14: f64,
    pub ema_5: f64,
    pub ema_20: f64,
    pub ema_50: f64,
    pub macd: f64,
    pub macd_signal: f64,
    pub bollinger_upper: f64,
    pub bollinger_lower: f64,
    pub atr_14: f64,
    pub updated_at: chrono::DateTime<Utc>,
}

impl TradingViewFeed {
    pub fn new() -> Self {
        Self {
            indicators: Arc::new(DashMap::new()),
            trends: Arc::new(DashMap::new()),
        }
    }

    pub fn is_connected(&self) -> bool {
        !self.indicators.is_empty()
    }

    pub fn get_trend(&self, symbol: &str) -> TrendState {
        self.trends
            .get(symbol)
            .map(|t| *t)
            .unwrap_or(TrendState::Sideways)
    }

    pub async fn run(&self) {
        info!("TradingView feed starting (EMA-based trend detection from Binance data)...");
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));

        loop {
            interval.tick().await;

            for symbol in &["btcusdt", "ethusdt", "solusdt"] {
                if let Err(e) = self.fetch_klines(symbol).await {
                    warn!("Kline fetch for {symbol} failed: {e}");
                }
            }
        }
    }

    /// Fetch recent klines from Binance REST (public, no auth) and derive
    /// EMA crossover trend state.
    async fn fetch_klines(&self, symbol: &str) -> Result<()> {
        let url = format!(
            "https://api.binance.com/api/v3/klines?symbol={}&interval=5m&limit=60",
            symbol.to_uppercase()
        );

        let client = reqwest::Client::new();
        let resp = client.get(&url).send().await?;
        let body: Vec<Vec<serde_json::Value>> = resp.json().await?;

        if body.len() < 50 {
            return Ok(());
        }

        let closes: Vec<f64> = body
            .iter()
            .filter_map(|k| k.get(4).and_then(|v| v.as_str()).and_then(|s| s.parse().ok()))
            .collect();

        if closes.len() < 50 {
            return Ok(());
        }

        let ema_5 = Self::ema(&closes, 5);
        let ema_20 = Self::ema(&closes, 20);
        let ema_50 = Self::ema(&closes, 50);

        let last = *closes.last().unwrap();
        let rsi = Self::rsi(&closes, 14);
        let atr = Self::atr(&body, 14);

        let (macd, macd_signal) = Self::macd(&closes);
        let (bb_upper, bb_lower) = Self::bollinger(&closes, 20);

        let trend = self.classify_trend(ema_5, ema_20, ema_50, rsi, macd, macd_signal);
        self.trends.insert(symbol.to_string(), trend);

        self.indicators.insert(
            symbol.to_string(),
            TechnicalIndicators {
                symbol: symbol.to_string(),
                rsi_14: rsi,
                ema_5,
                ema_20,
                ema_50,
                macd,
                macd_signal,
                bollinger_upper: bb_upper,
                bollinger_lower: bb_lower,
                atr_14: atr,
                updated_at: Utc::now(),
            },
        );

        Ok(())
    }

    fn classify_trend(
        &self,
        ema_5: f64,
        ema_20: f64,
        ema_50: f64,
        rsi: f64,
        macd: f64,
        macd_signal: f64,
    ) -> TrendState {
        let ema_up = ema_5 > ema_20 && ema_20 > ema_50;
        let ema_down = ema_5 < ema_20 && ema_20 < ema_50;
        let macd_bullish = macd > macd_signal;

        if ema_up && rsi > 60.0 && macd_bullish {
            TrendState::StrongUp
        } else if ema_up || (rsi > 55.0 && macd_bullish) {
            TrendState::WeakUp
        } else if ema_down && rsi < 40.0 && !macd_bullish {
            TrendState::StrongDown
        } else if ema_down || (rsi < 45.0 && !macd_bullish) {
            TrendState::WeakDown
        } else {
            TrendState::Sideways
        }
    }

    fn ema(data: &[f64], period: usize) -> f64 {
        if data.len() < period {
            return *data.last().unwrap_or(&0.0);
        }
        let k = 2.0 / (period as f64 + 1.0);
        let mut ema = data[..period].iter().sum::<f64>() / period as f64;
        for &val in &data[period..] {
            ema = val * k + ema * (1.0 - k);
        }
        ema
    }

    fn rsi(data: &[f64], period: usize) -> f64 {
        if data.len() < period + 1 {
            return 50.0;
        }
        let mut gains = 0.0;
        let mut losses = 0.0;
        let start = data.len() - period - 1;
        for i in (start + 1)..data.len() {
            let change = data[i] - data[i - 1];
            if change > 0.0 {
                gains += change;
            } else {
                losses += change.abs();
            }
        }
        let avg_gain = gains / period as f64;
        let avg_loss = losses / period as f64;
        if avg_loss == 0.0 {
            return 100.0;
        }
        100.0 - (100.0 / (1.0 + avg_gain / avg_loss))
    }

    fn macd(data: &[f64]) -> (f64, f64) {
        let ema_12 = Self::ema(data, 12);
        let ema_26 = Self::ema(data, 26);
        let macd_line = ema_12 - ema_26;
        let signal = macd_line * 0.2;
        (macd_line, signal)
    }

    fn bollinger(data: &[f64], period: usize) -> (f64, f64) {
        if data.len() < period {
            return (0.0, 0.0);
        }
        let slice = &data[data.len() - period..];
        let mean = slice.iter().sum::<f64>() / period as f64;
        let variance = slice.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / period as f64;
        let std_dev = variance.sqrt();
        (mean + 2.0 * std_dev, mean - 2.0 * std_dev)
    }

    fn atr(klines: &[Vec<serde_json::Value>], period: usize) -> f64 {
        if klines.len() < period + 1 {
            return 0.0;
        }
        let start = klines.len() - period - 1;
        let mut tr_sum = 0.0;
        for i in (start + 1)..klines.len() {
            let high: f64 = klines[i]
                .get(2)
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0);
            let low: f64 = klines[i]
                .get(3)
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0);
            let prev_close: f64 = klines[i - 1]
                .get(4)
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0);

            let tr = (high - low)
                .max((high - prev_close).abs())
                .max((low - prev_close).abs());
            tr_sum += tr;
        }
        tr_sum / period as f64
    }
}
