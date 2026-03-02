use anyhow::{Context, Result};
use chrono::Utc;
use parking_lot::Mutex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;
use tracing::{error, info, warn};

use crate::config::Config;
use crate::models::*;
use crate::risk::RiskManager;
use crate::signer::{OrderSigner, SignedOrder};

#[derive(Debug, Deserialize)]
struct ClobOrderResponse {
    #[serde(rename = "orderID")]
    order_id: Option<String>,
    success: Option<bool>,
    #[serde(rename = "errorMsg")]
    error_msg: Option<String>,
    status: Option<String>,
}

pub struct OrderExecutor {
    client: Client,
    signer: Option<Arc<OrderSigner>>,
    risk: Arc<RiskManager>,
    config: Config,
    trades: Arc<Mutex<Vec<Trade>>>,
    trade_count: Arc<Mutex<u64>>,
}

impl OrderExecutor {
    pub fn new(config: Config, risk: Arc<RiskManager>, signer: Option<Arc<OrderSigner>>) -> Self {
        let client = Client::builder()
            .pool_max_idle_per_host(10)
            .pool_idle_timeout(std::time::Duration::from_secs(30))
            .timeout(std::time::Duration::from_secs(config.risk.order_timeout_secs))
            .build()
            .expect("Failed to build HTTP client");

        Self {
            client,
            signer,
            risk,
            config,
            trades: Arc::new(Mutex::new(Vec::new())),
            trade_count: Arc::new(Mutex::new(0)),
        }
    }

    pub fn get_trades(&self) -> Vec<Trade> {
        self.trades.lock().clone()
    }

    pub fn get_pnl(&self) -> (f64, f64) {
        let trades = self.trades.lock();
        let realized: f64 = trades.iter().filter_map(|t| t.pnl).sum();
        let unrealized = 0.0; // Would need live book data to compute
        (realized, unrealized)
    }

    pub async fn execute(&self, signal: &Signal) -> Result<Trade> {
        let size = self
            .risk
            .check(signal)
            .context("Signal blocked by risk manager")?;

        let start = Instant::now();

        let trade_id = {
            let mut count = self.trade_count.lock();
            *count += 1;
            format!("trade-{}", *count)
        };

        let side_str = match signal.side {
            TradeSide::Buy => "BUY",
            TradeSide::Sell => "SELL",
        };

        let price = match signal.side {
            TradeSide::Buy => signal.implied_prob + 0.001,
            TradeSide::Sell => signal.implied_prob - 0.001,
        };

        let trade = Trade {
            id: trade_id.clone(),
            signal_id: signal.id.clone(),
            contract_token_id: signal.contract.token_id.clone(),
            asset: signal.contract.asset,
            side: signal.side,
            price,
            size,
            cost: size * price,
            divergence_at_entry: signal.divergence,
            status: TradeStatus::Pending,
            submitted_at: Utc::now(),
            filled_at: None,
            pnl: None,
        };

        self.risk.record_trade(&trade);

        if self.config.paper_mode {
            return self.paper_execute(trade, start).await;
        }

        let signer = self
            .signer
            .as_ref()
            .context("No signer configured for live trading")?;

        let signed = signer
            .sign_order(
                &signal.contract.token_id,
                side_str,
                price,
                size,
                false,
            )
            .await?;

        self.submit_to_clob(trade, signed, start).await
    }

    async fn paper_execute(&self, mut trade: Trade, start: Instant) -> Result<Trade> {
        let latency = start.elapsed();

        // Simulate fill with small slippage
        let slippage = (rand::random::<f64>() - 0.5) * 0.002;
        trade.price += slippage;
        trade.status = TradeStatus::Filled;
        trade.filled_at = Some(Utc::now());

        // Simulate P&L based on divergence closing
        let expected_pnl = trade.divergence_at_entry.abs() * trade.size * 0.5;
        let noise = (rand::random::<f64>() - 0.3) * expected_pnl * 0.4;
        trade.pnl = Some(expected_pnl + noise);

        self.risk.record_fill(&trade, trade.pnl.unwrap_or(0.0));

        info!(
            "PAPER FILL: {} {} {:.4}@{:.4} size=${:.2} pnl=${:.2} latency={:?}",
            trade.asset.binance_symbol(),
            if trade.side == TradeSide::Buy { "BUY" } else { "SELL" },
            trade.price,
            trade.divergence_at_entry,
            trade.size,
            trade.pnl.unwrap_or(0.0),
            latency,
        );

        self.trades.lock().push(trade.clone());
        Ok(trade)
    }

    async fn submit_to_clob(
        &self,
        mut trade: Trade,
        signed: SignedOrder,
        start: Instant,
    ) -> Result<Trade> {
        let url = format!("{}/order", self.config.polymarket_clob_url);

        let payload = serde_json::json!({
            "order": signed.order,
            "signature": signed.signature,
            "owner": format!("{:?}", self.signer.as_ref().unwrap().address()),
            "orderType": "GTC",
        });

        let resp = self
            .client
            .post(&url)
            .json(&payload)
            .send()
            .await
            .context("CLOB order submission failed")?;

        let latency = start.elapsed();
        let status = resp.status();

        if status.is_success() {
            let body: ClobOrderResponse = resp.json().await.unwrap_or(ClobOrderResponse {
                order_id: None,
                success: Some(false),
                error_msg: Some("Parse error".into()),
                status: None,
            });

            if body.success.unwrap_or(false) || body.order_id.is_some() {
                trade.status = TradeStatus::Filled;
                trade.filled_at = Some(Utc::now());

                info!(
                    "LIVE FILL: {} {} {:.4} size=${:.2} order_id={} latency={:?}",
                    trade.asset.binance_symbol(),
                    if trade.side == TradeSide::Buy { "BUY" } else { "SELL" },
                    trade.price,
                    trade.size,
                    body.order_id.as_deref().unwrap_or("?"),
                    latency,
                );
            } else {
                trade.status = TradeStatus::Rejected;
                warn!(
                    "Order rejected: {}",
                    body.error_msg.as_deref().unwrap_or("unknown")
                );
            }
        } else {
            let error_text = resp.text().await.unwrap_or_default();
            trade.status = TradeStatus::Rejected;
            error!("CLOB error {status}: {error_text}");

            if status.as_u16() != 429 {
                // Don't retry on rate limit
                return Ok(trade);
            }
        }

        self.trades.lock().push(trade.clone());
        Ok(trade)
    }
}
