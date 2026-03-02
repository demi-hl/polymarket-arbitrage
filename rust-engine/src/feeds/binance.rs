use anyhow::Result;
use chrono::Utc;
use dashmap::DashMap;
use futures_util::StreamExt;
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::broadcast;
use tokio_tungstenite::connect_async;
use tracing::{error, info, warn};

use crate::models::{CryptoAsset, Price, PriceSource};

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
    ws_url: String,
}

impl BinanceFeed {
    pub fn new(ws_url: &str) -> Self {
        let (tx, _) = broadcast::channel(1024);
        Self {
            prices: Arc::new(DashMap::new()),
            tx,
            ws_url: ws_url.to_string(),
        }
    }

    pub fn get_price(&self, asset: CryptoAsset) -> Option<Price> {
        self.prices.get(asset.binance_symbol()).map(|p| p.clone())
    }

    pub fn is_connected(&self) -> bool {
        !self.prices.is_empty()
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
        let url = url::Url::parse(&self.ws_url)?;
        let (ws_stream, _) = connect_async(url).await?;
        info!("Binance WS connected");

        let (_, mut read) = ws_stream.split();

        while let Some(msg) = read.next().await {
            let msg = msg?;
            if msg.is_text() {
                if let Ok(stream_msg) = serde_json::from_str::<BinanceStreamMsg>(msg.to_text().unwrap_or("")) {
                    let symbol = stream_msg.data.symbol.to_lowercase();
                    if let Ok(price_val) = stream_msg.data.last_price.parse::<f64>() {
                        let price = Price {
                            symbol: symbol.clone(),
                            price: price_val,
                            timestamp: Utc::now(),
                            source: PriceSource::Binance,
                        };
                        self.prices.insert(symbol, price.clone());
                        let _ = self.tx.send(price);
                    }
                }
            }
        }

        Ok(())
    }
}
