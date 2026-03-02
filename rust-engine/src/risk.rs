use chrono::Utc;
use parking_lot::Mutex;
use tracing::{info, warn};

use crate::config::Config;
use crate::models::*;

pub struct RiskManager {
    config: Config,
    state: Mutex<RiskState>,
}

impl RiskManager {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            state: Mutex::new(RiskState::default()),
        }
    }

    pub fn get_state(&self) -> RiskState {
        self.state.lock().clone()
    }

    /// Check whether a signal passes all risk gates. Returns None if blocked,
    /// or Some(adjusted_size) if approved.
    pub fn check(&self, signal: &Signal) -> Option<f64> {
        let state = self.state.lock();

        if state.halted {
            warn!("Risk HALTED: {}", state.halt_reason.as_deref().unwrap_or("unknown"));
            return None;
        }

        // Daily loss cap
        let daily_loss_limit = self.config.risk.daily_loss_cap_pct * self.config.risk.capital;
        if state.daily_pnl < -daily_loss_limit {
            warn!(
                "Daily loss cap hit: ${:.2} (limit: ${:.2})",
                state.daily_pnl, daily_loss_limit
            );
            return None;
        }

        // Max concurrent positions
        if state.open_positions >= self.config.risk.max_concurrent_positions {
            return None;
        }

        // Per-market cooldown
        let now = Utc::now();
        if let Some(last_time) = state.last_trade_time.get(&signal.contract.token_id) {
            let elapsed = (now - *last_time).num_seconds();
            if elapsed < self.config.risk.cooldown_per_market_secs as i64 {
                return None;
            }
        }

        // Consecutive loss circuit breaker (per contract type like "btc-15min")
        let contract_class = format!("{:?}-{}min", signal.contract.asset, signal.contract.expiry_minutes);
        if let Some(&losses) = state.consecutive_losses.get(&contract_class) {
            if losses >= self.config.risk.consecutive_loss_pause {
                warn!("Circuit breaker: {contract_class} paused ({losses} consecutive losses)");
                return None;
            }
        }

        // Position sizing: trend-adaptive
        let base_pct = if signal.trend_state.is_trending() {
            self.config.risk.trending_size_pct
        } else {
            self.config.risk.sideways_size_pct
        };

        let max_size = base_pct * self.config.risk.capital;
        let size = signal.suggested_size.min(max_size);

        // Hard floor
        if size < 1.0 {
            return None;
        }

        // Hard cap: never exceed max_per_trade_pct
        let hard_cap = self.config.risk.max_per_trade_pct * self.config.risk.capital;
        let final_size = size.min(hard_cap);

        Some(final_size)
    }

    pub fn record_trade(&self, trade: &Trade) {
        let mut state = self.state.lock();
        state.daily_trades += 1;
        state.open_positions += 1;

        state
            .last_trade_time
            .insert(trade.contract_token_id.clone(), trade.submitted_at);
    }

    pub fn record_fill(&self, trade: &Trade, pnl: f64) {
        let mut state = self.state.lock();
        state.daily_pnl += pnl;

        if state.open_positions > 0 {
            state.open_positions -= 1;
        }

        let contract_class = format!("{:?}-{}min", trade.asset, 15);
        if pnl < 0.0 {
            let count = state.consecutive_losses.entry(contract_class).or_insert(0);
            *count += 1;

            if *count >= self.config.risk.consecutive_loss_pause {
                info!(
                    "Circuit breaker triggered: pausing {:?} for {}s",
                    trade.asset, self.config.risk.consecutive_loss_pause_secs
                );
            }
        } else {
            state.consecutive_losses.remove(&contract_class);
        }
    }

    pub fn reset_daily(&self) {
        let mut state = self.state.lock();
        state.daily_pnl = 0.0;
        state.daily_trades = 0;
        state.halted = false;
        state.halt_reason = None;
        state.consecutive_losses.clear();
        info!("Daily risk counters reset");
    }

    pub fn halt(&self, reason: &str) {
        let mut state = self.state.lock();
        state.halted = true;
        state.halt_reason = Some(reason.to_string());
        warn!("RISK HALT: {reason}");
    }
}
