use anyhow::Result;
use chrono::Utc;
use dashmap::DashMap;
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::{info, warn};

use crate::models::{Price, PriceSource};

/// CryptoQuant provides on-chain flow data and price confirmation.
/// Acts as a secondary signal source — if Binance diverges AND CryptoQuant
/// confirms directional flow (exchange inflow = sell pressure, outflow = buy), we
/// trade with higher confidence.
pub struct CryptoQuantFeed {
    pub prices: Arc<DashMap<String, Price>>,
    pub flow_signals: Arc<DashMap<String, FlowSignal>>,
    pub tx: broadcast::Sender<Price>,
    api_key: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FlowSignal {
    pub asset: String,
    pub exchange_inflow: f64,
    pub exchange_outflow: f64,
    pub net_flow: f64,
    pub signal: FlowDirection,
    pub updated_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FlowDirection {
    Bullish,
    Bearish,
    Neutral,
}

impl CryptoQuantFeed {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self {
            prices: Arc::new(DashMap::new()),
            flow_signals: Arc::new(DashMap::new()),
            tx,
            api_key: std::env::var("CRYPTOQUANT_API_KEY").ok(),
        }
    }

    pub fn is_connected(&self) -> bool {
        !self.prices.is_empty()
    }

    pub fn get_flow(&self, asset: &str) -> Option<FlowSignal> {
        self.flow_signals.get(asset).map(|f| f.clone())
    }

    pub async fn run(&self) {
        if self.api_key.is_none() {
            warn!("CRYPTOQUANT_API_KEY not set, CryptoQuant feed disabled (using Binance-only mode)");
            return;
        }

        info!("CryptoQuant feed starting...");
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));

        loop {
            interval.tick().await;

            for asset in &["btc", "eth"] {
                if let Err(e) = self.fetch_price(asset).await {
                    warn!("CryptoQuant {asset} price fetch failed: {e}");
                }
                if let Err(e) = self.fetch_flow(asset).await {
                    warn!("CryptoQuant {asset} flow fetch failed: {e}");
                }
            }
        }
    }

    async fn fetch_price(&self, asset: &str) -> Result<()> {
        let api_key = self.api_key.as_ref().unwrap();
        let symbol = format!("{asset}usdt");
        let url = format!(
            "https://api.cryptoquant.com/v1/btc/market-data/price-usd?window=hour&limit=1"
        );

        let client = reqwest::Client::new();
        let resp = client
            .get(&url)
            .header("Authorization", format!("Bearer {api_key}"))
            .send()
            .await?;

        if resp.status().is_success() {
            let body: serde_json::Value = resp.json().await?;
            if let Some(price_val) = body["result"]["data"][0]["close"].as_f64() {
                let price = Price {
                    symbol: symbol.clone(),
                    price: price_val,
                    timestamp: Utc::now(),
                    source: PriceSource::CryptoQuant,
                };
                self.prices.insert(symbol, price.clone());
                let _ = self.tx.send(price);
            }
        }

        Ok(())
    }

    async fn fetch_flow(&self, asset: &str) -> Result<()> {
        let api_key = self.api_key.as_ref().unwrap();
        let url = format!(
            "https://api.cryptoquant.com/v1/{asset}/network-data/exchange-flows?window=hour&limit=1"
        );

        let client = reqwest::Client::new();
        let resp = client
            .get(&url)
            .header("Authorization", format!("Bearer {api_key}"))
            .send()
            .await?;

        if resp.status().is_success() {
            let body: serde_json::Value = resp.json().await?;
            if let Some(data) = body["result"]["data"].as_array().and_then(|a| a.first()) {
                let inflow = data["exchange_inflow"].as_f64().unwrap_or(0.0);
                let outflow = data["exchange_outflow"].as_f64().unwrap_or(0.0);
                let net = inflow - outflow;
                let signal = if net > 0.0 {
                    FlowDirection::Bearish
                } else if net < 0.0 {
                    FlowDirection::Bullish
                } else {
                    FlowDirection::Neutral
                };

                self.flow_signals.insert(
                    asset.to_string(),
                    FlowSignal {
                        asset: asset.to_string(),
                        exchange_inflow: inflow,
                        exchange_outflow: outflow,
                        net_flow: net,
                        signal,
                        updated_at: Utc::now(),
                    },
                );
            }
        }

        Ok(())
    }
}
