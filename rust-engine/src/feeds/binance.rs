use anyhow::Result;
use chrono::Utc;
use dashmap::DashMap;
use futures_util::StreamExt;
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::broadcast;
use tokio_tungstenite::connect_async;
use tracing::{error, info, warn};

use crate::models::{CryptoAsset, Price, PriceSource, PriceUpdate};

/// Minimum price change (as a ratio) to emit a PriceUpdate event.
/// 0.0001 = 0.01%
const MIN_CHANGE_RATIO: f64 = 0.0001;

#[derive(Debug, Deserialize)]
struct BinanceTicker {
    #[serde(rename = "s")]
    symbol: String,
    #[serde(rename = "c")]
    last_price: String,
    #[serde(rename = "P")]
    price_change_pct: String,
}

#[derive(Debug, Deserialize)]
struct BinanceStreamMsg {
    stream: String,
    data: BinanceTicker,
}

pub struct BinanceFeed {
    pub prices: Arc<DashMap<String, Price>>,
    pub tx: broadcast::Sender<Price>,
    /// Event channel: only fires when price changes by >= 0.01%
    price_update_tx: broadcast::Sender<PriceUpdate>,
    /// Tracks the last price that triggered an update, per symbol.
    /// Used to compute change percentage against the last *emitted* price,
    /// not the last raw tick (avoids flooding on sub-threshold jitter).
    last_emitted: DashMap<String, f64>,
    ws_url: String,
}

impl BinanceFeed {
    pub fn new(ws_url: &str) -> Self {
        let (tx, _) = broadcast::channel(1024);
        let (price_update_tx, _) = broadcast::channel(256);
        Self {
            prices: Arc::new(DashMap::new()),
            tx,
            price_update_tx,
            last_emitted: DashMap::new(),
            ws_url: ws_url.to_string(),
        }
    }

    pub fn get_price(&self, asset: CryptoAsset) -> Option<Price> {
        self.prices.get(asset.binance_symbol()).map(|p| p.clone())
    }

    pub fn is_connected(&self) -> bool {
        !self.prices.is_empty()
    }

    /// Subscribe to filtered price update events.
    /// Only fires when a symbol's price changes by >= 0.01% from the last emitted price.
    pub fn subscribe(&self) -> broadcast::Receiver<PriceUpdate> {
        self.price_update_tx.subscribe()
    }

    pub async fn run(&self) {
        let mut backoff = 1u64;

        loop {
            match self.connect_and_stream().await {
                Ok(()) => {
                    warn!("Binance WS disconnected cleanly, reconnecting...");
                    backoff = 1;
                }
                Err(e) => {
                    error!("Binance WS error: {e}, reconnecting in {backoff}s");
                }
            }

            tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(30);
        }
    }

    async fn connect_and_stream(&self) -> Result<()> {
        let (ws_stream, _) = connect_async(&self.ws_url).await?;
        info!("Binance WS connected");

        let (_, mut read) = ws_stream.split();

        while let Some(msg) = read.next().await {
            let msg = msg?;
            if msg.is_text() {
                if let Ok(stream_msg) = serde_json::from_str::<BinanceStreamMsg>(msg.to_text().unwrap_or("")) {
                    let symbol = stream_msg.data.symbol.to_lowercase();
                    if let Ok(price_val) = stream_msg.data.last_price.parse::<f64>() {
                        let now = Utc::now();
                        let price = Price {
                            symbol: symbol.clone(),
                            price: price_val,
                            timestamp: now,
                            source: PriceSource::Binance,
                        };

                        // Always update the raw price store and raw broadcast
                        self.prices.insert(symbol.clone(), price.clone());
                        let _ = self.tx.send(price);

                        // Check if price moved enough to emit a PriceUpdate
                        let should_emit = {
                            if let Some(prev) = self.last_emitted.get(&symbol) {
                                let prev_price = *prev;
                                if prev_price > 0.0 {
                                    let change = ((price_val - prev_price) / prev_price).abs();
                                    change >= MIN_CHANGE_RATIO
                                } else {
                                    true
                                }
                            } else {
                                true // First tick for this symbol
                            }
                        };

                        if should_emit {
                            let prev_price = self
                                .last_emitted
                                .get(&symbol)
                                .map(|v| *v)
                                .unwrap_or(price_val);
                            let change_pct = if prev_price > 0.0 {
                                (price_val - prev_price) / prev_price
                            } else {
                                0.0
                            };

                            let asset = CryptoAsset::from_str_loose(&symbol);
                            if let Some(asset) = asset {
                                let update = PriceUpdate {
                                    symbol: symbol.clone(),
                                    asset,
                                    price: price_val,
                                    prev_price,
                                    change_pct,
                                    timestamp: now,
                                };
                                let _ = self.price_update_tx.send(update);
                            }

                            self.last_emitted.insert(symbol, price_val);
                        }
                    }
                }
            }
        }

        Ok(())
    }
}
