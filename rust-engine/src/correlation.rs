use chrono::Utc;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use tracing::info;

use crate::config::Config;
use crate::feeds::polymarket::PolymarketFeed;
use crate::models::*;

/// Detects mispricing between logically correlated Polymarket markets.
///
/// Example: "Will Trump win the primary?" vs "Will Trump win the presidency?"
/// If P(win primary) > P(win presidency), that's a violation since winning
/// the presidency requires winning the primary first (subset relationship).
static CORR_SIGNAL_COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct CorrelationDetector {
    config: Config,
    pairs: Mutex<Vec<CorrelatedPair>>,
    /// Cooldown: pair_id -> last signal time
    cooldowns: Mutex<HashMap<String, chrono::DateTime<Utc>>>,
    /// Minimum violation to emit signal (after fees)
    min_net_edge: f64,
    /// Cooldown between signals on the same pair
    cooldown_secs: u64,
}

impl CorrelationDetector {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            pairs: Mutex::new(Vec::new()),
            cooldowns: Mutex::new(HashMap::new()),
            min_net_edge: 0.02,   // 2% minimum net edge
            cooldown_secs: 300,   // 5 minute cooldown per pair
        }
    }

    /// Register a correlated pair for monitoring. Returns true if newly added.
    pub fn add_pair(&self, pair: CorrelatedPair) -> bool {
        let mut pairs = self.pairs.lock();
        if pairs.iter().any(|p| p.id == pair.id) {
            return false;
        }
        info!("Registered correlation pair: {} ({:?})", pair.id, pair.relationship);
        pairs.push(pair);
        true
    }

    /// Get all registered pairs.
    pub fn get_pairs(&self) -> Vec<CorrelatedPair> {
        self.pairs.lock().clone()
    }

    /// Scan all registered pairs against current Polymarket orderbook state.
    /// Returns signals for any pairs that violate their logical constraint
    /// with sufficient edge after fees.
    pub fn scan(&self, polymarket: &PolymarketFeed) -> Vec<CorrelationSignal> {
        let pairs = self.pairs.lock().clone();
        let now = Utc::now();
        let mut signals = Vec::new();

        for pair in &pairs {
            // Check cooldown
            {
                let cooldowns = self.cooldowns.lock();
                if let Some(last) = cooldowns.get(&pair.id) {
                    let elapsed = now.signed_duration_since(*last).num_seconds();
                    if elapsed < self.cooldown_secs as i64 {
                        continue;
                    }
                }
            }

            // Get orderbook mid prices for both markets
            let book_a = match polymarket.get_book(&pair.market_a_token) {
                Some(b) => b,
                None => continue,
            };
            let book_b = match polymarket.get_book(&pair.market_b_token) {
                Some(b) => b,
                None => continue,
            };

            let price_a = book_a.mid_price;
            let price_b = book_b.mid_price;

            // Skip stale or invalid prices
            if price_a <= 0.01 || price_a >= 0.99 || price_b <= 0.01 || price_b >= 0.99 {
                continue;
            }

            // Detect violation based on relationship type
            let violation = match pair.relationship {
                // Subset: P(A) <= P(B), so violation = P(A) - P(B) when positive
                Relationship::Subset => {
                    if price_a > price_b {
                        price_a - price_b
                    } else {
                        0.0
                    }
                }
                // Superset: P(A) >= P(B), so violation = P(B) - P(A) when positive
                Relationship::Superset => {
                    if price_b > price_a {
                        price_b - price_a
                    } else {
                        0.0
                    }
                }
                // Mutually exclusive: P(A) + P(B) <= 1
                Relationship::MutuallyExclusive => {
                    let sum = price_a + price_b;
                    if sum > 1.0 {
                        sum - 1.0
                    } else {
                        0.0
                    }
                }
                // Complementary: P(A) + P(B) >= 1
                Relationship::Complementary => {
                    let sum = price_a + price_b;
                    if sum < 1.0 {
                        1.0 - sum
                    } else {
                        0.0
                    }
                }
            };

            if violation < 0.005 {
                continue; // noise floor
            }

            // Estimate round-trip fees (entry + exit on both legs)
            // Maker entry = 0 bps, taker exit = 50 bps per leg, 2 legs
            let fee_estimate = 2.0 * (self.config.paper.exit_fee_bps / 10_000.0);
            let net_edge = violation - fee_estimate;

            if net_edge < self.min_net_edge {
                continue;
            }

            // Determine which side to buy/sell
            let (buy_token, sell_token) = match pair.relationship {
                Relationship::Subset => {
                    // A is overpriced relative to B → sell A, buy B
                    ("b".to_string(), "a".to_string())
                }
                Relationship::Superset => {
                    // B is overpriced relative to A → sell B, buy A
                    ("a".to_string(), "b".to_string())
                }
                Relationship::MutuallyExclusive => {
                    // Both overpriced → sell the more expensive one, buy the cheaper
                    if price_a > price_b {
                        ("b".to_string(), "a".to_string())
                    } else {
                        ("a".to_string(), "b".to_string())
                    }
                }
                Relationship::Complementary => {
                    // Both underpriced → buy the cheaper one, sell the more expensive
                    if price_a < price_b {
                        ("a".to_string(), "b".to_string())
                    } else {
                        ("b".to_string(), "a".to_string())
                    }
                }
            };

            // Position sizing: min of available liquidity and risk limit
            let max_size = self.config.risk.capital * self.config.risk.max_per_trade_pct;
            let liquidity = (book_a.bid_size.min(book_b.bid_size)) * 0.8;
            let suggested_size = max_size.min(liquidity).min(200.0).max(self.config.risk.min_trade_size);

            let confidence = (net_edge / 0.10).min(1.0); // 10% edge = max confidence

            let signal = CorrelationSignal {
                id: format!("corr-sig-{}", CORR_SIGNAL_COUNTER.fetch_add(1, Ordering::Relaxed)),
                pair: pair.clone(),
                price_a,
                price_b,
                violation,
                net_edge,
                confidence,
                buy_token,
                sell_token,
                suggested_size,
                timestamp: now,
            };

            info!(
                "CORR SIGNAL: {} violation={:.4} net_edge={:.4} conf={:.2} size=${:.2}",
                pair.label.as_deref().unwrap_or(&pair.id),
                violation,
                net_edge,
                confidence,
                suggested_size,
            );

            // Record cooldown
            self.cooldowns.lock().insert(pair.id.clone(), now);
            signals.push(signal);
        }

        signals
    }
}
