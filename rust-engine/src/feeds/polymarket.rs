use anyhow::Result;
use chrono::Utc;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tracing::{error, info, warn};

use crate::models::{CryptoContract, OrderbookState};

#[derive(Debug, Serialize)]
struct SubscribeMsg {
    auth: serde_json::Value,
    markets: Vec<String>,
    assets_ids: Vec<String>,
    r#type: String,
}

#[derive(Debug, Deserialize)]
struct WsEvent {
    event_type: Option<String>,
    asset_id: Option<String>,
    market: Option<String>,
    price: Option<String>,
    changes: Option<Vec<Vec<String>>>,
}

pub struct PolymarketFeed {
    pub orderbooks: Arc<DashMap<String, OrderbookState>>,
    pub contracts: Arc<RwLock<Vec<CryptoContract>>>,
    pub tx: broadcast::Sender<OrderbookState>,
    ws_url: String,
}

impl PolymarketFeed {
    pub fn new(ws_url: &str) -> Self {
        let (tx, _) = broadcast::channel(1024);
        Self {
            orderbooks: Arc::new(DashMap::new()),
            contracts: Arc::new(RwLock::new(Vec::new())),
            tx,
            ws_url: ws_url.to_string(),
        }
    }

    pub fn get_book(&self, token_id: &str) -> Option<OrderbookState> {
        self.orderbooks.get(token_id).map(|b| b.clone())
    }

    pub fn is_connected(&self) -> bool {
        !self.orderbooks.is_empty()
    }

    pub fn book_count(&self) -> u32 {
        self.orderbooks.len() as u32
    }

    pub async fn add_contracts(&self, new_contracts: Vec<CryptoContract>) {
        let mut contracts = self.contracts.write().await;
        for c in new_contracts {
            if !contracts.iter().any(|existing| existing.token_id == c.token_id) {
                contracts.push(c);
            }
        }
    }

    pub async fn run(&self) {
        let mut backoff = 1u64;

        loop {
            let token_ids: Vec<String> = {
                let contracts = self.contracts.read().await;
                contracts.iter().map(|c| c.token_id.clone()).collect()
            };

            if token_ids.is_empty() {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }

            match self.connect_and_stream(&token_ids).await {
                Ok(()) => {
                    warn!("Polymarket WS disconnected, reconnecting...");
                    backoff = 1;
                }
                Err(e) => {
                    error!("Polymarket WS error: {e}, reconnecting in {backoff}s");
                }
            }

            tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(30);
        }
    }

    async fn connect_and_stream(&self, token_ids: &[String]) -> Result<()> {
        let (ws_stream, _) = connect_async(&self.ws_url).await?;
        info!("Polymarket WS connected, subscribing to {} tokens", token_ids.len());

        let (mut write, mut read) = ws_stream.split();

        let sub = SubscribeMsg {
            auth: serde_json::json!({}),
            markets: Vec::new(),
            assets_ids: token_ids.to_vec(),
            r#type: "market".to_string(),
        };
        write.send(Message::Text(serde_json::to_string(&sub)?.into())).await?;

        while let Some(msg) = read.next().await {
            let msg = msg?;
            if msg.is_text() {
                let text = msg.to_text().unwrap_or("");

                if let Ok(events) = serde_json::from_str::<Vec<WsEvent>>(text) {
                    for event in events {
                        self.handle_event(&event);
                    }
                } else if let Ok(event) = serde_json::from_str::<WsEvent>(text) {
                    self.handle_event(&event);
                }
            }
        }

        Ok(())
    }

    fn handle_event(&self, event: &WsEvent) {
        let token_id = match &event.asset_id {
            Some(id) => id.clone(),
            None => return,
        };

        if let Some(changes) = &event.changes {
            let mut best_bid = 0.0f64;
            let mut best_ask = 1.0f64;
            let mut bid_size = 0.0f64;
            let mut ask_size = 0.0f64;

            for change in changes {
                if change.len() < 3 {
                    continue;
                }
                let side = &change[0];
                let price: f64 = change[1].parse().unwrap_or(0.0);
                let size: f64 = change[2].parse().unwrap_or(0.0);

                match side.as_str() {
                    "BUY" | "buy" => {
                        if price > best_bid {
                            best_bid = price;
                            bid_size = size;
                        }
                    }
                    "SELL" | "sell" => {
                        if price < best_ask {
                            best_ask = price;
                            ask_size = size;
                        }
                    }
                    _ => {}
                }
            }

            if best_bid > 0.0 {
                let book = OrderbookState {
                    token_id: token_id.clone(),
                    best_bid,
                    best_ask,
                    bid_size,
                    ask_size,
                    mid_price: (best_bid + best_ask) / 2.0,
                    spread: best_ask - best_bid,
                    updated_at: Utc::now(),
                };
                self.orderbooks.insert(token_id, book.clone());
                let _ = self.tx.send(book);
            }
        } else if let Some(price_str) = &event.price {
            if let Ok(price) = price_str.parse::<f64>() {
                let book = OrderbookState {
                    token_id: token_id.clone(),
                    best_bid: price,
                    best_ask: price,
                    bid_size: 0.0,
                    ask_size: 0.0,
                    mid_price: price,
                    spread: 0.0,
                    updated_at: Utc::now(),
                };
                self.orderbooks.insert(token_id, book.clone());
                let _ = self.tx.send(book);
            }
        }
    }
}
