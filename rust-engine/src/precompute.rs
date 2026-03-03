use chrono::Utc;
use dashmap::DashMap;
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::{info, warn};

use crate::config::Config;
use crate::detector::{calculate_probability, expiry_weight};
use crate::executor::OrderExecutor;
use crate::feeds::binance::BinanceFeed;
use crate::feeds::cryptoquant::CryptoQuantFeed;
use crate::feeds::polymarket::PolymarketFeed;
use crate::feeds::tradingview::TradingViewFeed;
use crate::models::*;
use crate::risk::RiskManager;
use crate::trend::TrendDetector;

/// Pre-computed probability cache that reacts to price and book events.
///
/// On each Binance PriceUpdate:
///   - Recomputes Black-Scholes for ALL contracts of that asset
///   - Stores results in `cache` (DashMap keyed by token_id)
///   - Checks divergence for each contract and emits signals immediately
///
/// On each Polymarket BookUpdate:
///   - Updates the implied prob for that specific contract
///   - Checks if divergence now exceeds threshold (instant signal)
pub struct ProbabilityCache {
    /// Cached probabilities keyed by token_id
    pub cache: Arc<DashMap<String, CachedProb>>,
    config: Config,
}

impl ProbabilityCache {
    pub fn new(config: Config) -> Self {
        Self {
            cache: Arc::new(DashMap::new()),
            config,
        }
    }

    /// Get the cached probability for a contract.
    pub fn get(&self, token_id: &str) -> Option<CachedProb> {
        self.cache.get(token_id).map(|v| v.clone())
    }

    /// Spawn the event-driven computation loop.
    /// Subscribes to both Binance price updates and Polymarket book updates,
    /// recomputing probabilities and checking divergence on every event.
    pub async fn run(
        self: Arc<Self>,
        binance: Arc<BinanceFeed>,
        polymarket: Arc<PolymarketFeed>,
        cryptoquant: Arc<CryptoQuantFeed>,
        tradingview: Arc<TradingViewFeed>,
        executor: Arc<OrderExecutor>,
        _risk: Arc<RiskManager>,
        recent_signals: Arc<parking_lot::Mutex<Vec<Signal>>>,
    ) {
        let mut price_rx = binance.subscribe();
        let mut book_rx = polymarket.subscribe();

        // Shared mutable state for the event loop
        let mut signal_count: u64 = 0;
        let cooldowns: DashMap<String, chrono::DateTime<Utc>> = DashMap::new();
        // Per-asset volatility cache, refreshed from TrendDetector via the binance
        // price window. We maintain a local TrendDetector for volatility tracking
        // since the main detector's TrendDetector isn't Send-safe for sharing.
        let mut trend_detector = TrendDetector::new();

        info!("ProbabilityCache event loop started");

        loop {
            tokio::select! {
                // ── Binance price changed ──
                result = price_rx.recv() => {
                    match result {
                        Ok(update) => {
                            // Update local trend detector with the new price
                            trend_detector.update(&update.symbol, update.price);
                            let vol = trend_detector.get_volatility(&update.symbol);

                            // Get all contracts for this asset
                            let contracts = polymarket.contracts.read().await;
                            let asset_contracts: Vec<_> = contracts
                                .iter()
                                .filter(|c| c.asset == update.asset)
                                .cloned()
                                .collect();
                            drop(contracts);

                            let now = Utc::now();

                            for contract in &asset_contracts {
                                let secs_to_expiry = (contract.expiry - now).num_seconds();
                                if secs_to_expiry < 60 || secs_to_expiry < 0 {
                                    continue;
                                }

                                let prob = calculate_probability(
                                    update.price,
                                    contract.strike_price,
                                    contract.direction,
                                    secs_to_expiry as f64,
                                    contract.asset,
                                    vol,
                                );

                                // Update cache
                                self.cache.insert(
                                    contract.token_id.clone(),
                                    CachedProb {
                                        token_id: contract.token_id.clone(),
                                        asset: contract.asset,
                                        prob,
                                        vol,
                                        binance_price: update.price,
                                        strike: contract.strike_price,
                                        direction: contract.direction,
                                        secs_to_expiry: secs_to_expiry as f64,
                                        timestamp: now,
                                    },
                                );

                                // Check divergence against current Polymarket book
                                if let Some(book) = polymarket.get_book(&contract.token_id) {
                                    let implied_prob = book.mid_price;
                                    if let Some(signal) = self.try_signal(
                                        contract,
                                        prob,
                                        implied_prob,
                                        vol,
                                        &tradingview,
                                        &cryptoquant,
                                        &cooldowns,
                                        &mut signal_count,
                                    ) {
                                        self.handle_signal(
                                            signal,
                                            &contract.token_id,
                                            &executor,
                                            &recent_signals,
                                            &cooldowns,
                                        ).await;
                                    }
                                }
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            warn!("ProbabilityCache: price_rx lagged by {n} messages");
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            warn!("ProbabilityCache: price_rx closed, exiting");
                            break;
                        }
                    }
                }

                // ── Polymarket book changed ──
                result = book_rx.recv() => {
                    match result {
                        Ok(update) => {
                            let implied_prob = update.mid_price;

                            // Look up cached probability for this contract
                            if let Some(cached) = self.cache.get(&update.token_id) {
                                let cached = cached.clone();

                                // Find the contract metadata
                                let contracts = polymarket.contracts.read().await;
                                let contract = contracts
                                    .iter()
                                    .find(|c| c.token_id == update.token_id)
                                    .cloned();
                                drop(contracts);

                                if let Some(contract) = contract {
                                    let vol = trend_detector.get_volatility(contract.asset.binance_symbol());

                                    if let Some(signal) = self.try_signal(
                                        &contract,
                                        cached.prob,
                                        implied_prob,
                                        vol,
                                        &tradingview,
                                        &cryptoquant,
                                        &cooldowns,
                                        &mut signal_count,
                                    ) {
                                        self.handle_signal(
                                            signal,
                                            &contract.token_id,
                                            &executor,
                                            &recent_signals,
                                            &cooldowns,
                                        ).await;
                                    }
                                }
                            }
                            // If no cached prob exists yet, the next Binance tick will populate it
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            warn!("ProbabilityCache: book_rx lagged by {n} messages");
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            warn!("ProbabilityCache: book_rx closed, exiting");
                            break;
                        }
                    }
                }
            }
        }
    }

    /// Try to generate a signal from a divergence between actual and implied probability.
    /// Returns None if below threshold, in cooldown, or filtered out.
    fn try_signal(
        &self,
        contract: &CryptoContract,
        actual_prob: f64,
        implied_prob: f64,
        _vol: f64,
        tradingview: &TradingViewFeed,
        cryptoquant: &CryptoQuantFeed,
        cooldowns: &DashMap<String, chrono::DateTime<Utc>>,
        signal_count: &mut u64,
    ) -> Option<Signal> {
        let now = Utc::now();

        // Check cooldown
        if let Some(expires) = cooldowns.get(&contract.token_id) {
            if *expires > now {
                return None;
            }
        }

        // Skip extreme probabilities
        if implied_prob <= 0.01 || implied_prob >= 0.99 {
            return None;
        }

        let divergence = actual_prob - implied_prob;
        let abs_divergence = divergence.abs();

        let symbol = contract.asset.binance_symbol();
        let trend = tradingview.get_trend(symbol);
        let threshold = trend.divergence_threshold();

        if abs_divergence < threshold {
            return None;
        }

        // Multi-source confirmation
        let mut sources_agreeing: u8 = 1;
        if let Some(flow) = cryptoquant.get_flow(&symbol[..3]) {
            let flow_agrees = match contract.direction {
                Direction::Above => {
                    (divergence > 0.0
                        && flow.signal == crate::feeds::cryptoquant::FlowDirection::Bullish)
                        || (divergence < 0.0
                            && flow.signal == crate::feeds::cryptoquant::FlowDirection::Bearish)
                }
                Direction::Below => {
                    (divergence > 0.0
                        && flow.signal == crate::feeds::cryptoquant::FlowDirection::Bearish)
                        || (divergence < 0.0
                            && flow.signal == crate::feeds::cryptoquant::FlowDirection::Bullish)
                }
            };
            if flow_agrees {
                sources_agreeing += 1;
            }
        }

        if sources_agreeing < self.config.detection.min_sources_agree {
            return None;
        }

        let side = if divergence > 0.0 {
            TradeSide::Buy
        } else {
            TradeSide::Sell
        };

        let exp_weight = expiry_weight(contract.expiry_minutes);
        let confidence = (abs_divergence / threshold).min(3.0) / 3.0
            * (sources_agreeing as f64 / 3.0).min(1.0)
            * exp_weight;

        let base_size = self.config.risk.max_per_trade_pct * self.config.risk.capital;
        let edge_multiplier = if abs_divergence >= 0.20 { 3.0 } else if abs_divergence >= 0.10 { 2.0 } else { 1.0 };
        let asset_multiplier = if contract.asset == CryptoAsset::BTC { 1.5 } else { 1.0 };
        let suggested_size = (base_size * trend.position_size_multiplier() * confidence * edge_multiplier * asset_multiplier).max(10.0);

        // Skip if below minimum trade size
        if suggested_size < 10.0 {
            return None;
        }

        *signal_count += 1;
        let signal = Signal {
            id: format!("sig-evt-{}", signal_count),
            contract: contract.clone(),
            side,
            implied_prob,
            actual_prob,
            divergence,
            confidence,
            suggested_size,
            timestamp: now,
            sources_agreeing,
            trend_state: trend,
        };

        info!(
            "EVENT-SIGNAL: {} {} {:.4} div={:.4} conf={:.2} trend={:?} size=${:.2}",
            signal.contract.asset.binance_symbol(),
            if signal.side == TradeSide::Buy { "BUY" } else { "SELL" },
            signal.implied_prob,
            signal.divergence,
            signal.confidence,
            signal.trend_state,
            signal.suggested_size,
        );

        Some(signal)
    }

    /// Handle a generated signal: store it, execute it, set cooldown.
    async fn handle_signal(
        &self,
        signal: Signal,
        token_id: &str,
        executor: &OrderExecutor,
        recent_signals: &parking_lot::Mutex<Vec<Signal>>,
        cooldowns: &DashMap<String, chrono::DateTime<Utc>>,
    ) {
        // Store signal
        {
            let mut recent = recent_signals.lock();
            recent.push(signal.clone());
            if recent.len() > 1000 {
                let drain = recent.len() - 1000;
                recent.drain(..drain);
            }
        }

        // Set cooldown immediately to prevent duplicate signals
        let cooldown_secs = self.config.risk.cooldown_per_market_secs as i64;
        cooldowns.insert(
            token_id.to_string(),
            Utc::now() + chrono::Duration::seconds(cooldown_secs),
        );

        // Execute
        match executor.execute(&signal).await {
            Ok(trade) => {
                info!(
                    "EVENT-TRADE: {} {:?} status={:?}",
                    trade.id, trade.side, trade.status
                );
            }
            Err(e) => {
                warn!("EVENT-TRADE failed: {e}");
            }
        }
    }
}
