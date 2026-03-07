use chrono::Utc;
use parking_lot::RwLock;
use std::collections::HashMap;
use tracing::info;

use crate::config::Config;
use crate::feeds::polymarket::PolymarketFeed;
use crate::models::*;

/// Minimum violation (raw price difference) to consider a signal.
/// Matches the JS strategy's 3% floor.
const MIN_VIOLATION: f64 = 0.03;

/// Fee estimate in price terms (0.8% round-trip: entry + exit).
const FEE_ESTIMATE: f64 = 0.008;

/// Minimum net edge after fees to emit a signal.
const MIN_NET_EDGE: f64 = 0.02;

/// Max signals per scan cycle to avoid flooding the executor.
const MAX_SIGNALS_PER_SCAN: usize = 8;

pub struct CorrelationDetector {
    config: Config,
    pairs: RwLock<Vec<CorrelatedPair>>,
    cooldowns: RwLock<HashMap<String, chrono::DateTime<Utc>>>,
    signal_count: parking_lot::Mutex<u64>,
}

impl CorrelationDetector {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            pairs: RwLock::new(Vec::new()),
            cooldowns: RwLock::new(HashMap::new()),
            signal_count: parking_lot::Mutex::new(0),
        }
    }

    /// Register a new correlated pair. Returns false if the pair already exists.
    pub fn add_pair(&self, pair: CorrelatedPair) -> bool {
        let mut pairs = self.pairs.write();
        if pairs.iter().any(|p| p.id == pair.id) {
            return false;
        }
        pairs.push(pair);
        true
    }

    /// Remove a pair by id. Returns true if found and removed.
    pub fn remove_pair(&self, pair_id: &str) -> bool {
        let mut pairs = self.pairs.write();
        let before = pairs.len();
        pairs.retain(|p| p.id != pair_id);
        pairs.len() < before
    }

    /// Get all registered pairs.
    pub fn get_pairs(&self) -> Vec<CorrelatedPair> {
        self.pairs.read().clone()
    }

    /// Scan all registered correlated pairs against live orderbook data.
    /// Returns correlation violation signals sorted by net_edge descending.
    pub fn scan(&self, polymarket: &PolymarketFeed) -> Vec<CorrelationSignal> {
        let now = Utc::now();
        let mut signals = Vec::new();

        // Purge expired cooldowns
        {
            let mut cooldowns = self.cooldowns.write();
            cooldowns.retain(|_, expires| *expires > now);
        }

        let pairs = self.pairs.read().clone();

        for pair in &pairs {
            // Check cooldown
            {
                let cooldowns = self.cooldowns.read();
                if cooldowns.contains_key(&pair.id) {
                    continue;
                }
            }

            // Fetch orderbook state for both tokens
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

            // Skip extreme prices — no edge available
            if price_a <= 0.01 || price_a >= 0.99 || price_b <= 0.01 || price_b >= 0.99 {
                continue;
            }

            // Detect violation based on relationship type
            let violation_result = detect_violation(pair.relationship, price_a, price_b);

            let (violation, buy_token, sell_token) = match violation_result {
                Some(v) => v,
                None => continue,
            };

            if violation < MIN_VIOLATION {
                continue;
            }

            let net_edge = (violation - FEE_ESTIMATE).max(0.0);
            if net_edge < MIN_NET_EDGE {
                continue;
            }

            // Confidence: capped at 0.85, scaled by violation magnitude
            let confidence = (violation * 3.0).min(0.85);

            // Position sizing: conservative — 1% of min-side liquidity, capped
            let min_size = book_a.bid_size.min(book_b.bid_size);
            let suggested_size = (min_size * 0.01)
                .min(self.config.risk.max_per_trade_pct * self.config.risk.capital)
                .min(200.0);

            if suggested_size < 1.0 {
                continue;
            }

            let signal_id = {
                let mut count = self.signal_count.lock();
                *count += 1;
                format!("corr-sig-{}", *count)
            };

            info!(
                "CORR SIGNAL: {} | A={:.4} B={:.4} viol={:.4} edge={:.4} conf={:.2} size=${:.2}",
                pair.label.as_deref().unwrap_or(&pair.id),
                price_a,
                price_b,
                violation,
                net_edge,
                confidence,
                suggested_size,
            );

            // Set cooldown for this pair
            {
                let cooldown_secs = self.config.risk.cooldown_per_market_secs as i64;
                let mut cooldowns = self.cooldowns.write();
                cooldowns.insert(
                    pair.id.clone(),
                    now + chrono::Duration::seconds(cooldown_secs),
                );
            }

            signals.push(CorrelationSignal {
                id: signal_id,
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
            });
        }

        // Sort by net_edge descending, take top N
        signals.sort_by(|a, b| b.net_edge.partial_cmp(&a.net_edge).unwrap_or(std::cmp::Ordering::Equal));
        signals.truncate(MAX_SIGNALS_PER_SCAN);
        signals
    }
}

/// Given a relationship type and two prices, detect if a logical violation exists.
/// Returns Some((violation_magnitude, buy_token_id, sell_token_id)) or None.
///
/// The buy/sell tokens are string references to "a" or "b" — the caller maps
/// them to the actual pair tokens. We return the token IDs directly from the pair.
fn detect_violation(
    relationship: Relationship,
    price_a: f64,
    price_b: f64,
) -> Option<(f64, String, String)> {
    match relationship {
        Relationship::Subset => {
            // A is subset of B: P(A) must be <= P(B).
            // Violation: price_a > price_b.
            // Trade: buy B (underpriced superset), sell A (overpriced subset).
            // But wait — we return token IDs from the pair struct, so the caller
            // needs to know which side to buy. We use placeholder strings "a"/"b"
            // that get resolved by the caller.
            if price_a > price_b {
                let violation = price_a - price_b;
                Some((violation, "b".to_string(), "a".to_string()))
            } else {
                None
            }
        }
        Relationship::Superset => {
            // A is superset of B: P(A) must be >= P(B).
            // Violation: price_a < price_b.
            // Trade: buy A (underpriced superset), sell B (overpriced subset).
            if price_b > price_a {
                let violation = price_b - price_a;
                Some((violation, "a".to_string(), "b".to_string()))
            } else {
                None
            }
        }
        Relationship::MutuallyExclusive => {
            // A and B cannot both be true: P(A) + P(B) <= 1.
            // Violation: price_a + price_b > 1.
            // Trade: sell both (both overpriced). We pick the more overpriced one
            // as the primary sell, buy the NO side.
            let sum = price_a + price_b;
            if sum > 1.0 {
                let violation = sum - 1.0;
                // Sell whichever is more expensive
                if price_a >= price_b {
                    Some((violation, "b".to_string(), "a".to_string()))
                } else {
                    Some((violation, "a".to_string(), "b".to_string()))
                }
            } else {
                None
            }
        }
        Relationship::Complementary => {
            // A and B are complementary: P(A) + P(B) >= 1.
            // Violation: price_a + price_b < 1.
            // Trade: buy both (both underpriced). Buy whichever is cheaper.
            let sum = price_a + price_b;
            if sum < 1.0 {
                let violation = 1.0 - sum;
                if price_a <= price_b {
                    Some((violation, "a".to_string(), "b".to_string()))
                } else {
                    Some((violation, "b".to_string(), "a".to_string()))
                }
            } else {
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_subset_violation() {
        // A is subset of B. A=0.50, B=0.40 => violation, A is overpriced
        let result = detect_violation(Relationship::Subset, 0.50, 0.40);
        assert!(result.is_some());
        let (v, buy, sell) = result.unwrap();
        assert!((v - 0.10).abs() < 1e-10);
        assert_eq!(buy, "b"); // buy the superset (underpriced)
        assert_eq!(sell, "a"); // sell the subset (overpriced)
    }

    #[test]
    fn test_subset_no_violation() {
        // A is subset of B. A=0.30, B=0.50 => no violation
        let result = detect_violation(Relationship::Subset, 0.30, 0.50);
        assert!(result.is_none());
    }

    #[test]
    fn test_superset_violation() {
        // A is superset of B. A=0.40, B=0.60 => violation, A is underpriced
        let result = detect_violation(Relationship::Superset, 0.40, 0.60);
        assert!(result.is_some());
        let (v, buy, sell) = result.unwrap();
        assert!((v - 0.20).abs() < 1e-10);
        assert_eq!(buy, "a"); // buy the superset (underpriced)
        assert_eq!(sell, "b"); // sell the subset (overpriced)
    }

    #[test]
    fn test_mutually_exclusive_violation() {
        // P(A) + P(B) > 1 => impossible
        let result = detect_violation(Relationship::MutuallyExclusive, 0.60, 0.50);
        assert!(result.is_some());
        let (v, _buy, sell) = result.unwrap();
        assert!((v - 0.10).abs() < 1e-10);
        assert_eq!(sell, "a"); // sell the more expensive one
    }

    #[test]
    fn test_mutually_exclusive_no_violation() {
        let result = detect_violation(Relationship::MutuallyExclusive, 0.40, 0.50);
        assert!(result.is_none());
    }

    #[test]
    fn test_complementary_violation() {
        // P(A) + P(B) < 1 => both underpriced
        let result = detect_violation(Relationship::Complementary, 0.30, 0.20);
        assert!(result.is_some());
        let (v, buy, _sell) = result.unwrap();
        assert!((v - 0.50).abs() < 1e-10);
        assert_eq!(buy, "b"); // buy the cheaper one
    }

    #[test]
    fn test_complementary_no_violation() {
        let result = detect_violation(Relationship::Complementary, 0.60, 0.50);
        assert!(result.is_none());
    }
}
