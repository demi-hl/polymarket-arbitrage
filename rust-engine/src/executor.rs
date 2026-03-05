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

/// Recorded latency for a single trade execution.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LatencyRecord {
    /// Microseconds from signal timestamp to order submission start
    pub signal_latency_us: u64,
    /// Microseconds for the full execution round-trip
    pub execution_latency_us: u64,
}

pub struct OrderExecutor {
    client: Client,
    signer: Option<Arc<OrderSigner>>,
    risk: Arc<RiskManager>,
    config: Config,
    trades: Arc<Mutex<Vec<Trade>>>,
    trade_count: Arc<Mutex<u64>>,
    latency_history: Arc<Mutex<Vec<LatencyRecord>>>,
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
            latency_history: Arc::new(Mutex::new(Vec::new())),
        }
    }

    const TRADES_FILE: &'static str = "data/rust-trades.json";

    pub fn get_trades(&self) -> Vec<Trade> {
        self.trades.lock().clone()
    }

    pub fn load_trades(&self) {
        match std::fs::read_to_string(Self::TRADES_FILE) {
            Ok(data) => {
                match serde_json::from_str::<Vec<Trade>>(&data) {
                    Ok(saved) => {
                        let count = saved.len() as u64;
                        *self.trades.lock() = saved;
                        *self.trade_count.lock() = count;
                        info!("Loaded {} persisted trades from disk", count);
                    }
                    Err(e) => warn!("Failed to parse trades file: {}", e),
                }
            }
            Err(_) => info!("No persisted trades found, starting fresh"),
        }
    }

    pub fn save_trades(&self) {
        let trades = self.trades.lock();
        if let Ok(json) = serde_json::to_string(&*trades) {
            let _ = std::fs::create_dir_all("data");
            if let Err(e) = std::fs::write(Self::TRADES_FILE, json) {
                warn!("Failed to persist trades: {}", e);
            }
        }
    }

    pub fn get_latency_history(&self) -> Vec<LatencyRecord> {
        self.latency_history.lock().clone()
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

        // Compute signal-to-submission latency (signal.timestamp -> now)
        let now_utc = Utc::now();
        let signal_latency_us = now_utc
            .signed_duration_since(signal.timestamp)
            .num_microseconds()
            .map(|us| us.max(0) as u64);

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
            signal_latency_us,
            execution_latency_us: None, // filled after execution completes
        };

        self.risk.record_trade(&trade);

        let mut result = if self.config.paper_mode {
            self.paper_execute(trade, start).await
        } else {
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
        };

        // Record end-to-end execution latency
        if let Ok(ref mut trade) = result {
            let execution_us = start.elapsed().as_micros() as u64;
            trade.execution_latency_us = Some(execution_us);

            // Store latency record for analytics
            if let Some(sig_us) = trade.signal_latency_us {
                self.latency_history.lock().push(LatencyRecord {
                    signal_latency_us: sig_us,
                    execution_latency_us: execution_us,
                });
            }
        }

        result
    }

    async fn paper_execute(&self, mut trade: Trade, start: Instant) -> Result<Trade> {
        let latency = start.elapsed();
        let latency_ms = latency.as_millis() as f64;
        let mut rng = rand::thread_rng();
        let paper = &self.config.paper;

        let base_spread_bps = paper.base_spread_bps
            + trade.divergence_at_entry.abs() * 10_000.0 * 0.6;
        let spread_bps = Self::clamp(base_spread_bps, paper.base_spread_bps, paper.max_spread_bps);

        // Market impact: larger orders move the price more
        // $10 order = ~0 bps impact, $50 = ~10 bps, $100 = ~25 bps
        let market_impact_bps = (trade.size / 10.0).sqrt() * 5.0;

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
            self.save_trades();
            return Ok(trade);
        }

        let dir = if trade.side == TradeSide::Buy { 1.0 } else { -1.0 };

        // Maker entry: much lower slippage (posting at mid, not crossing spread)
        let jitter_entry_bps = rng.gen_range(-paper.slippage_jitter_bps..=paper.slippage_jitter_bps);
        let entry_slippage_bps = Self::clamp(
            paper.base_slippage_bps
                + spread_bps * 0.5
                + market_impact_bps
                + (latency_ms / 100.0) * paper.latency_impact_bps_per_100ms
                + jitter_entry_bps,
            0.0,
            paper.max_spread_bps * 2.0,
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
        // Shadow path: use same adversarial model as main path
        let shadow_convergence = if rng.gen::<f64>() < 0.40 {
            // 40% of the time, market moves against us
            rng.gen_range(paper.min_convergence_ratio..0.0_f64)
        } else {
            rng.gen_range(0.0_f64..=paper.max_convergence_ratio)
        };
        let shadow_move = trade.divergence_at_entry.abs() * shadow_convergence;
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
        // Maker entry = 0% fee, taker exit = 50bps (#5)
        let fees_paid = filled_notional * paper.exit_fee_bps / 10_000.0;
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
        self.save_trades();
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
        self.save_trades();
        Ok(trade)
    }

    /// Execute a two-leg correlated arbitrage trade.
    ///
    /// Leg 1: BUY the underpriced token (buy_token)
    /// Leg 2: SELL the overpriced token (sell_token)
    ///
    /// Both legs are recorded as separate Trade entries tagged with the
    /// correlation signal id. In paper mode we use simplified paper fills.
    pub async fn execute_correlation(&self, signal: &CorrelationSignal) -> Result<Vec<Trade>> {
        let start = Instant::now();
        let now_utc = Utc::now();

        let signal_latency_us = now_utc
            .signed_duration_since(signal.timestamp)
            .num_microseconds()
            .map(|us| us.max(0) as u64);

        let size = signal.suggested_size;
        if size < 1.0 {
            anyhow::bail!("Correlation signal size too small: {size}");
        }

        // Resolve which token IDs correspond to buy/sell
        let (buy_token_id, buy_price) = if signal.buy_token == "a" {
            (signal.pair.market_a_token.clone(), signal.price_a)
        } else {
            (signal.pair.market_b_token.clone(), signal.price_b)
        };

        let (sell_token_id, sell_price) = if signal.sell_token == "a" {
            (signal.pair.market_a_token.clone(), signal.price_a)
        } else {
            (signal.pair.market_b_token.clone(), signal.price_b)
        };

        let mut trades = Vec::with_capacity(2);

        // Leg 1: BUY underpriced token
        let buy_trade = self.build_corr_trade(
            &signal.id,
            &buy_token_id,
            TradeSide::Buy,
            buy_price + 0.001, // aggressive limit
            size,
            signal.violation,
            signal_latency_us,
        );

        // Leg 2: SELL overpriced token (buy NO = sell YES)
        let sell_trade = self.build_corr_trade(
            &signal.id,
            &sell_token_id,
            TradeSide::Sell,
            sell_price - 0.001,
            size,
            signal.violation,
            signal_latency_us,
        );

        if self.config.paper_mode {
            let filled_buy = self.paper_corr_execute(buy_trade, start, signal.violation).await?;
            let filled_sell = self.paper_corr_execute(sell_trade, start, signal.violation).await?;
            trades.push(filled_buy);
            trades.push(filled_sell);
        } else {
            let signer = self
                .signer
                .as_ref()
                .context("No signer configured for live trading")?;

            // Submit both legs concurrently for speed
            let signed_buy = signer
                .sign_order(&buy_token_id, "BUY", buy_price + 0.001, size, false)
                .await?;
            let signed_sell = signer
                .sign_order(&sell_token_id, "SELL", sell_price - 0.001, size, false)
                .await?;

            let (result_buy, result_sell) = tokio::join!(
                self.submit_to_clob(buy_trade, signed_buy, start),
                self.submit_to_clob(sell_trade, signed_sell, start),
            );

            trades.push(result_buy?);
            trades.push(result_sell?);
        }

        // Record latencies
        let execution_us = start.elapsed().as_micros() as u64;
        for trade in &mut trades {
            trade.execution_latency_us = Some(execution_us);
            if let Some(sig_us) = trade.signal_latency_us {
                self.latency_history.lock().push(LatencyRecord {
                    signal_latency_us: sig_us,
                    execution_latency_us: execution_us,
                });
            }
        }

        Ok(trades)
    }

    fn build_corr_trade(
        &self,
        signal_id: &str,
        token_id: &str,
        side: TradeSide,
        price: f64,
        size: f64,
        violation: f64,
        signal_latency_us: Option<u64>,
    ) -> Trade {
        let trade_id = {
            let mut count = self.trade_count.lock();
            *count += 1;
            format!("corr-trade-{}", *count)
        };

        Trade {
            id: trade_id,
            signal_id: signal_id.to_string(),
            contract_token_id: token_id.to_string(),
            asset: CryptoAsset::BTC, // correlation trades are market-agnostic; BTC as placeholder
            side,
            price,
            size,
            cost: size * price,
            divergence_at_entry: violation,
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
            signal_latency_us,
            execution_latency_us: None,
        }
    }

    /// Simplified paper execution for correlation trades.
    /// Correlation arbs are held until resolution, so we model the fill
    /// but don't simulate a full exit cycle.
    async fn paper_corr_execute(
        &self,
        mut trade: Trade,
        start: Instant,
        violation: f64,
    ) -> Result<Trade> {
        let latency_ms = start.elapsed().as_millis() as f64;
        let mut rng = rand::thread_rng();
        let paper = &self.config.paper;

        let dir = if trade.side == TradeSide::Buy { 1.0 } else { -1.0 };

        let jitter_bps = rng.gen_range(-paper.slippage_jitter_bps..=paper.slippage_jitter_bps);
        let entry_slippage_bps = Self::clamp(
            paper.base_slippage_bps
                + paper.base_spread_bps * 0.5
                + (latency_ms / 100.0) * paper.latency_impact_bps_per_100ms
                + jitter_bps,
            0.0,
            paper.max_spread_bps * 1.5,
        );

        let entry_price = Self::clamp(
            trade.price * (1.0 + dir * entry_slippage_bps / 10_000.0),
            0.01,
            0.99,
        );

        let fees_paid = trade.size * (paper.entry_fee_bps / 10_000.0);

        trade.price = entry_price;
        trade.cost = trade.size * entry_price;
        trade.status = TradeStatus::Filled;
        trade.filled_at = Some(Utc::now());
        trade.fees_paid = Some(fees_paid);
        trade.fill_ratio = Some(1.0);
        trade.entry_slippage_bps = Some(entry_slippage_bps);
        // PnL computed at resolution, not at entry
        trade.pnl = None;

        info!(
            "PAPER CORR FILL: {} {} entry={:.4} size=${:.2} viol={:.4} fees=${:.2} latency={}ms",
            if trade.side == TradeSide::Buy { "BUY" } else { "SELL" },
            trade.contract_token_id,
            entry_price,
            trade.size,
            violation,
            fees_paid,
            latency_ms as u64,
        );

        self.trades.lock().push(trade.clone());
        self.save_trades();
        Ok(trade)
    }
}
