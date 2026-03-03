use chrono::Utc;
use std::collections::HashMap;
use tracing::info;

use crate::config::Config;
use crate::feeds::binance::BinanceFeed;
use crate::feeds::cryptoquant::CryptoQuantFeed;
use crate::feeds::polymarket::PolymarketFeed;
use crate::feeds::tradingview::TradingViewFeed;
use crate::models::*;
use crate::trend::TrendDetector;

pub struct DivergenceDetector {
    config: Config,
    trend_detector: TrendDetector,
    cooldowns: HashMap<String, chrono::DateTime<Utc>>,
    signal_count: u64,
}

impl DivergenceDetector {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            trend_detector: TrendDetector::new(),
            cooldowns: HashMap::new(),
            signal_count: 0,
        }
    }

    pub fn get_trend(&self, symbol: &str) -> TrendState {
        self.trend_detector.get_trend(symbol)
    }

    pub fn update_trend(&mut self, symbol: &str, price: f64) -> TrendState {
        self.trend_detector.update(symbol, price)
    }

    /// Get the volatility from the internal trend detector.
    /// Exposed so ProbabilityCache can read it without owning the TrendDetector.
    pub fn get_volatility(&self, symbol: &str) -> f64 {
        self.trend_detector.get_volatility(symbol)
    }

    pub fn scan(
        &mut self,
        binance: &BinanceFeed,
        polymarket: &PolymarketFeed,
        cryptoquant: &CryptoQuantFeed,
        tradingview: &TradingViewFeed,
        contracts: &[CryptoContract],
    ) -> Vec<Signal> {
        let now = Utc::now();
        let mut signals = Vec::new();

        // Purge expired cooldowns
        self.cooldowns.retain(|_, expires| *expires > now);

        for contract in contracts {
            if self.cooldowns.contains_key(&contract.token_id) {
                continue;
            }

            // Skip contracts expiring within 60 seconds (too risky)
            let secs_to_expiry = (contract.expiry - now).num_seconds();
            if secs_to_expiry < 60 || secs_to_expiry < 0 {
                continue;
            }

            let binance_price = match binance.get_price(contract.asset) {
                Some(p) => p,
                None => continue,
            };

            let book = match polymarket.get_book(&contract.token_id) {
                Some(b) => b,
                None => continue,
            };

            // Implied probability from Polymarket YES price
            let implied_prob = book.mid_price;
            if implied_prob <= 0.01 || implied_prob >= 0.99 {
                continue; // Too extreme, no edge
            }

            let vol = self.trend_detector.get_volatility(contract.asset.binance_symbol());

            // Actual probability from real price vs strike
            let actual_prob = calculate_probability(
                binance_price.price,
                contract.strike_price,
                contract.direction,
                secs_to_expiry as f64,
                contract.asset,
                vol,
            );

            let divergence = actual_prob - implied_prob;
            let abs_divergence = divergence.abs();

            // Trend-adaptive threshold with book-depth adjustment (#6)
            let symbol = contract.asset.binance_symbol();
            let trend = tradingview.get_trend(symbol);
            let base_threshold = trend.divergence_threshold();

            // Dynamic threshold: thin books need higher edge to overcome slippage
            let book_depth = book.bid_size + book.ask_size;
            let depth_penalty = if book_depth < 50.0 {
                0.05 // very thin book: +5% threshold
            } else if book_depth < 200.0 {
                0.02 // thin book: +2%
            } else {
                0.0 // liquid book: no penalty
            };
            let threshold = base_threshold + depth_penalty;

            if abs_divergence < threshold {
                continue;
            }

            // Multi-source confirmation
            let mut sources_agreeing: u8 = 1; // Binance always counts

            if let Some(flow) = cryptoquant.get_flow(&symbol[..3]) {
                let flow_agrees = match contract.direction {
                    Direction::Above => {
                        (divergence > 0.0 && flow.signal == crate::feeds::cryptoquant::FlowDirection::Bullish)
                            || (divergence < 0.0 && flow.signal == crate::feeds::cryptoquant::FlowDirection::Bearish)
                    }
                    Direction::Below => {
                        (divergence > 0.0 && flow.signal == crate::feeds::cryptoquant::FlowDirection::Bearish)
                            || (divergence < 0.0 && flow.signal == crate::feeds::cryptoquant::FlowDirection::Bullish)
                    }
                };
                if flow_agrees {
                    sources_agreeing += 1;
                }
            }

            if sources_agreeing < self.config.detection.min_sources_agree {
                continue;
            }

            // Determine trade side: if actual > implied, the YES token is underpriced -> buy
            let side = if divergence > 0.0 {
                TradeSide::Buy
            } else {
                TradeSide::Sell
            };

            // Expiry priority weighting
            let expiry_weight = expiry_weight(contract.expiry_minutes);

            // Confidence combines divergence magnitude, source agreement, and expiry priority
            let confidence = (abs_divergence / threshold).min(3.0) / 3.0
                * (sources_agreeing as f64 / 3.0).min(1.0)
                * expiry_weight;

            // Suggested size based on trend, edge multiplier, and asset multiplier
            let base_size = self.config.risk.max_per_trade_pct * self.config.risk.capital;
            let edge_multiplier = if abs_divergence >= 0.20 { 3.0 } else if abs_divergence >= 0.10 { 2.0 } else { 1.0 };
            let asset_multiplier = if contract.asset == CryptoAsset::BTC { 1.5 } else { 1.0 };
            let suggested_size = (base_size * trend.position_size_multiplier() * confidence * edge_multiplier * asset_multiplier).max(10.0);

            // Skip if below minimum trade size
            if suggested_size < 10.0 {
                continue;
            }

            self.signal_count += 1;
            let signal = Signal {
                id: format!("sig-{}", self.signal_count),
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
                "SIGNAL: {} {} {:.4} div={:.4} conf={:.2} trend={:?} size=${:.2}",
                signal.contract.asset.binance_symbol(),
                if signal.side == TradeSide::Buy { "BUY" } else { "SELL" },
                signal.implied_prob,
                signal.divergence,
                signal.confidence,
                signal.trend_state,
                signal.suggested_size,
            );

            // Set cooldown
            let cooldown_secs = self.config.risk.cooldown_per_market_secs as i64;
            self.cooldowns.insert(
                contract.token_id.clone(),
                now + chrono::Duration::seconds(cooldown_secs),
            );

            signals.push(signal);
        }

        signals
    }

    /// Check whether a single contract has a divergence exceeding its threshold.
    /// Used by the event-driven path for instant signal generation.
    /// Returns Some(signal) if divergence exceeds threshold, None otherwise.
    pub fn check_divergence(
        &mut self,
        contract: &CryptoContract,
        binance_price: f64,
        implied_prob: f64,
        vol: f64,
        trend: TrendState,
        cryptoquant: &CryptoQuantFeed,
    ) -> Option<Signal> {
        let now = Utc::now();

        // Check cooldown
        if let Some(expires) = self.cooldowns.get(&contract.token_id) {
            if *expires > now {
                return None;
            }
        }

        // Skip contracts expiring within 60 seconds
        let secs_to_expiry = (contract.expiry - now).num_seconds();
        if secs_to_expiry < 60 || secs_to_expiry < 0 {
            return None;
        }

        // Skip extreme probabilities
        if implied_prob <= 0.01 || implied_prob >= 0.99 {
            return None;
        }

        let actual_prob = calculate_probability(
            binance_price,
            contract.strike_price,
            contract.direction,
            secs_to_expiry as f64,
            contract.asset,
            vol,
        );

        let divergence = actual_prob - implied_prob;
        let abs_divergence = divergence.abs();
        let threshold = trend.divergence_threshold();

        if abs_divergence < threshold {
            return None;
        }

        // Multi-source confirmation
        let symbol = contract.asset.binance_symbol();
        let mut sources_agreeing: u8 = 1;

        if let Some(flow) = cryptoquant.get_flow(&symbol[..3]) {
            let flow_agrees = match contract.direction {
                Direction::Above => {
                    (divergence > 0.0 && flow.signal == crate::feeds::cryptoquant::FlowDirection::Bullish)
                        || (divergence < 0.0 && flow.signal == crate::feeds::cryptoquant::FlowDirection::Bearish)
                }
                Direction::Below => {
                    (divergence > 0.0 && flow.signal == crate::feeds::cryptoquant::FlowDirection::Bearish)
                        || (divergence < 0.0 && flow.signal == crate::feeds::cryptoquant::FlowDirection::Bullish)
                }
            };
            if flow_agrees {
                sources_agreeing += 1;
            }
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

        self.signal_count += 1;
        let signal = Signal {
            id: format!("sig-evt-{}", self.signal_count),
            contract: contract.clone(),
            side,
            implied_prob,
            actual_prob,
            divergence,
            confidence,
            suggested_size: 0.0, // Caller fills this in with config-aware sizing
            timestamp: now,
            sources_agreeing,
            trend_state: trend,
        };

        Some(signal)
    }

    /// Record a cooldown for a token_id (called after signal is acted on).
    pub fn set_cooldown(&mut self, token_id: &str) {
        let cooldown_secs = self.config.risk.cooldown_per_market_secs as i64;
        self.cooldowns.insert(
            token_id.to_string(),
            Utc::now() + chrono::Duration::seconds(cooldown_secs),
        );
    }

    /// Check if a token_id is currently in cooldown.
    pub fn is_cooled_down(&self, token_id: &str) -> bool {
        if let Some(expires) = self.cooldowns.get(token_id) {
            *expires > Utc::now()
        } else {
            false
        }
    }
}

// ── Standalone (public) functions for use by ProbabilityCache ──

/// Black-Scholes-inspired probability: how likely is the asset to be above/below
/// the strike at expiry, given current price and historical volatility.
///
/// This is extracted as a standalone function so ProbabilityCache can call it
/// without needing a mutable borrow on DivergenceDetector.
pub fn calculate_probability(
    current_price: f64,
    strike: f64,
    direction: Direction,
    secs_to_expiry: f64,
    asset: CryptoAsset,
    vol: f64,
) -> f64 {
    // Annualized vol (from per-tick vol, assuming ~1s ticks)
    let annualized_vol = if vol > 0.0 {
        vol * (365.25 * 24.0 * 3600.0f64).sqrt()
    } else {
        match asset {
            CryptoAsset::BTC => 0.60,
            CryptoAsset::ETH => 0.75,
            CryptoAsset::SOL => 0.90,
        }
    };

    let t = secs_to_expiry / (365.25 * 24.0 * 3600.0);
    if t <= 0.0 {
        return if current_price >= strike { 1.0 } else { 0.0 };
    }

    let d = ((current_price / strike).ln()) / (annualized_vol * t.sqrt());
    let prob_above = normal_cdf(d);

    match direction {
        Direction::Above => prob_above,
        Direction::Below => 1.0 - prob_above,
    }
}

/// Expiry priority weighting — shorter expiry contracts get higher priority.
pub fn expiry_weight(expiry_minutes: u32) -> f64 {
    match expiry_minutes {
        0..=15 => 1.0,
        16..=60 => 0.8,
        61..=240 => 0.6,
        _ => 0.4,
    }
}

/// Abramowitz-Stegun approximation of the standard normal CDF.
pub fn normal_cdf(x: f64) -> f64 {
    let a1 = 0.254829592;
    let a2 = -0.284496736;
    let a3 = 1.421413741;
    let a4 = -1.453152027;
    let a5 = 1.061405429;
    let p = 0.3275911;

    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let x = x.abs() / std::f64::consts::SQRT_2;
    let t = 1.0 / (1.0 + p * x);
    let y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * (-x * x).exp();

    0.5 * (1.0 + sign * y)
}
