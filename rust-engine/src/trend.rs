use std::collections::VecDeque;

use crate::models::TrendState;

/// EMA-crossover trend detector operating on streaming Binance ticks.
/// Maintains a rolling window of prices and emits trend state changes
/// for the divergence detector and risk manager.
pub struct TrendDetector {
    windows: std::collections::HashMap<String, PriceWindow>,
}

struct PriceWindow {
    prices: VecDeque<f64>,
    ema_fast: f64,
    ema_slow: f64,
    ema_very_slow: f64,
    initialized: bool,
}

const FAST_PERIOD: f64 = 5.0;
const SLOW_PERIOD: f64 = 20.0;
const VERY_SLOW_PERIOD: f64 = 50.0;
const MAX_WINDOW: usize = 200;

impl PriceWindow {
    fn new() -> Self {
        Self {
            prices: VecDeque::with_capacity(MAX_WINDOW),
            ema_fast: 0.0,
            ema_slow: 0.0,
            ema_very_slow: 0.0,
            initialized: false,
        }
    }

    fn update(&mut self, price: f64) -> TrendState {
        self.prices.push_back(price);
        if self.prices.len() > MAX_WINDOW {
            self.prices.pop_front();
        }

        if !self.initialized {
            if self.prices.len() < VERY_SLOW_PERIOD as usize {
                return TrendState::Sideways;
            }
            let sum: f64 = self.prices.iter().take(FAST_PERIOD as usize).sum();
            self.ema_fast = sum / FAST_PERIOD;
            let sum: f64 = self.prices.iter().take(SLOW_PERIOD as usize).sum();
            self.ema_slow = sum / SLOW_PERIOD;
            let sum: f64 = self.prices.iter().take(VERY_SLOW_PERIOD as usize).sum();
            self.ema_very_slow = sum / VERY_SLOW_PERIOD;
            self.initialized = true;
        }

        let k_fast = 2.0 / (FAST_PERIOD + 1.0);
        let k_slow = 2.0 / (SLOW_PERIOD + 1.0);
        let k_vs = 2.0 / (VERY_SLOW_PERIOD + 1.0);

        self.ema_fast = price * k_fast + self.ema_fast * (1.0 - k_fast);
        self.ema_slow = price * k_slow + self.ema_slow * (1.0 - k_slow);
        self.ema_very_slow = price * k_vs + self.ema_very_slow * (1.0 - k_vs);

        self.classify()
    }

    fn classify(&self) -> TrendState {
        let ema_up = self.ema_fast > self.ema_slow && self.ema_slow > self.ema_very_slow;
        let ema_down = self.ema_fast < self.ema_slow && self.ema_slow < self.ema_very_slow;

        let spread_pct = ((self.ema_fast - self.ema_very_slow) / self.ema_very_slow).abs();
        let strong = spread_pct > 0.002;

        if ema_up && strong {
            TrendState::StrongUp
        } else if ema_up {
            TrendState::WeakUp
        } else if ema_down && strong {
            TrendState::StrongDown
        } else if ema_down {
            TrendState::WeakDown
        } else {
            TrendState::Sideways
        }
    }
}

impl TrendDetector {
    pub fn new() -> Self {
        Self {
            windows: std::collections::HashMap::new(),
        }
    }

    pub fn update(&mut self, symbol: &str, price: f64) -> TrendState {
        let window = self
            .windows
            .entry(symbol.to_string())
            .or_insert_with(PriceWindow::new);
        window.update(price)
    }

    pub fn get_trend(&self, symbol: &str) -> TrendState {
        self.windows
            .get(symbol)
            .map(|w| w.classify())
            .unwrap_or(TrendState::Sideways)
    }

    pub fn get_volatility(&self, symbol: &str) -> f64 {
        self.windows
            .get(symbol)
            .map(|w| {
                if w.prices.len() < 20 {
                    return 0.0;
                }
                let prices: Vec<f64> = w.prices.iter().copied().collect();
                let returns: Vec<f64> = prices
                    .windows(2)
                    .map(|p| (p[1] / p[0]).ln())
                    .collect();
                let mean = returns.iter().sum::<f64>() / returns.len() as f64;
                let variance =
                    returns.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / returns.len() as f64;
                variance.sqrt()
            })
            .unwrap_or(0.0)
    }
}
