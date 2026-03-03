use anyhow::{Context, Result};
use chrono::Utc;
use parking_lot::Mutex;
use reqwest::Client;
use rand::Rng;
use serde::Deserialize;
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
    fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
        v.max(lo).min(hi)
    }

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
            exit_price: None,
            fees_paid: None,
            fill_ratio: None,
            hold_ms: None,
            entry_slippage_bps: None,
            exit_slippage_bps: None,
            shadow_entry_price: None,
            shadow_exit_price: None,
            shadow_pnl: None,
            shadow_slippage_bps: None,
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
        let latency_ms = latency.as_millis() as f64;
        let mut rng = rand::thread_rng();
        let paper = &self.config.paper;

        let base_spread_bps = paper.base_spread_bps
            + trade.divergence_at_entry.abs() * 10_000.0 * 0.6;
        let spread_bps = Self::clamp(base_spread_bps, paper.base_spread_bps, paper.max_spread_bps);

        let fill_ratio = if rng.gen::<f64>() < paper.partial_fill_probability {
            rng.gen_range(paper.min_partial_fill_ratio..=1.0)
        } else {
            1.0
        };
        if fill_ratio < paper.min_fill_to_execute_ratio {
            trade.status = TradeStatus::Cancelled;
            trade.pnl = Some(0.0);
            trade.fill_ratio = Some(fill_ratio);
            self.trades.lock().push(trade.clone());
            return Ok(trade);
        }

        let dir = if trade.side == TradeSide::Buy { 1.0 } else { -1.0 };
        let jitter_entry_bps = rng.gen_range(-paper.slippage_jitter_bps..=paper.slippage_jitter_bps);
        let entry_slippage_bps = Self::clamp(
            paper.base_slippage_bps
                + spread_bps * 0.5
                + (latency_ms / 100.0) * paper.latency_impact_bps_per_100ms
                + jitter_entry_bps,
            0.0,
            paper.max_spread_bps * 1.5,
        );

        let entry_price = Self::clamp(
            trade.price * (1.0 + dir * entry_slippage_bps / 10_000.0),
            0.01,
            0.99,
        );

        let hold_ms = if paper.max_hold_ms > paper.min_hold_ms {
            rng.gen_range(paper.min_hold_ms..=paper.max_hold_ms)
        } else {
            paper.min_hold_ms
        };

        // Asymmetric convergence: ~40% chance of adverse price move (realistic)
        let convergence_ratio = if rng.gen::<f64>() < 0.4 {
            rng.gen_range(paper.min_convergence_ratio..0.0_f64)
        } else {
            rng.gen_range(0.0_f64..=paper.max_convergence_ratio)
        };
        let move_from_convergence = trade.divergence_at_entry.abs() * convergence_ratio;
        let noise = (rng.gen::<f64>() - 0.5) * move_from_convergence * paper.noise_std_ratio;
        let modeled_move = Self::clamp(move_from_convergence + noise, -0.20, 0.20);

        let jitter_exit_bps = rng.gen_range(-paper.slippage_jitter_bps..=paper.slippage_jitter_bps);
        let exit_slippage_bps = Self::clamp(
            paper.base_slippage_bps * 0.8 + spread_bps * 0.4 + jitter_exit_bps,
            0.0,
            paper.max_spread_bps * 1.5,
        );

        let exit_price = Self::clamp(
            entry_price * (1.0 + dir * modeled_move - dir * exit_slippage_bps / 10_000.0),
            0.01,
            0.99,
        );

        // "Shadow-live" benchmark path: deterministic, lower-noise execution estimate.
        // This gives us a stable comparator to score paper realism drift.
        let shadow_entry_bps = Self::clamp(
            paper.base_slippage_bps * 0.7
                + spread_bps * 0.35
                + (latency_ms / 100.0) * paper.latency_impact_bps_per_100ms * 0.8,
            0.0,
            paper.max_spread_bps * 1.2,
        );
        let shadow_exit_bps = Self::clamp(
            paper.base_slippage_bps * 0.6 + spread_bps * 0.3,
            0.0,
            paper.max_spread_bps * 1.2,
        );
        let shadow_entry_price = Self::clamp(
            trade.price * (1.0 + dir * shadow_entry_bps / 10_000.0),
            0.01,
            0.99,
        );
        let shadow_move = trade.divergence_at_entry.abs() * 0.65;
        let shadow_exit_price = Self::clamp(
            shadow_entry_price * (1.0 + dir * shadow_move - dir * shadow_exit_bps / 10_000.0),
            0.01,
            0.99,
        );

        let filled_notional = trade.size * fill_ratio;
        let shares = if entry_price > 0.0 {
            filled_notional / entry_price
        } else {
            0.0
        };
        let gross_pnl = (exit_price - entry_price) * shares * dir;
        let fees_paid = filled_notional * (paper.entry_fee_bps + paper.exit_fee_bps) / 10_000.0;
        let net_pnl = gross_pnl - fees_paid;
        let shadow_shares = if shadow_entry_price > 0.0 {
            filled_notional / shadow_entry_price
        } else {
            0.0
        };
        let shadow_gross = (shadow_exit_price - shadow_entry_price) * shadow_shares * dir;
        let shadow_pnl = shadow_gross - fees_paid;

        trade.price = entry_price;
        trade.size = filled_notional;
        trade.cost = filled_notional;
        trade.status = TradeStatus::Filled;
        trade.filled_at = Some(Utc::now());
        trade.pnl = Some(net_pnl);
        trade.exit_price = Some(exit_price);
        trade.fees_paid = Some(fees_paid);
        trade.fill_ratio = Some(fill_ratio);
        trade.hold_ms = Some(hold_ms);
        trade.entry_slippage_bps = Some(entry_slippage_bps);
        trade.exit_slippage_bps = Some(exit_slippage_bps);
        trade.shadow_entry_price = Some(shadow_entry_price);
        trade.shadow_exit_price = Some(shadow_exit_price);
        trade.shadow_pnl = Some(shadow_pnl);
        trade.shadow_slippage_bps = Some(shadow_entry_bps);

        self.risk.record_fill(&trade, net_pnl);

        info!(
            "PAPER FILL: {} {} entry={:.4} exit={:.4} size=${:.2} fill={:.0}% pnl=${:.2} fees=${:.2} hold={}ms latency={}ms",
            trade.asset.binance_symbol(),
            if trade.side == TradeSide::Buy { "BUY" } else { "SELL" },
            entry_price,
            exit_price,
            trade.size,
            fill_ratio * 100.0,
            net_pnl,
            fees_paid,
            hold_ms,
            latency_ms as u64,
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
