use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tracing::info;

use crate::models::*;
use crate::AppState;

pub fn create_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/prices", get(prices))
        .route("/signals", get(signals))
        .route("/trades", get(trades))
        .route("/pnl", get(pnl))
        .route("/config", post(update_config))
        .route("/markets", post(register_markets))
        .route("/status", get(status))
        .route("/latency", get(latency))
        .route("/correlations", get(list_correlations).post(register_correlations))
        .route("/correlations/signals", get(correlation_signals))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    engine: &'static str,
    version: &'static str,
    uptime_secs: u64,
    paper_mode: bool,
    feeds: FeedStatus,
}

async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    let uptime = state.start_time.elapsed().as_secs();
    let feeds = FeedStatus {
        binance_connected: state.binance.is_connected(),
        binance_last_price: state.binance.get_price(CryptoAsset::BTC).map(|p| p.price),
        polymarket_connected: state.polymarket.is_connected(),
        polymarket_books: state.polymarket.book_count(),
        cryptoquant_connected: state.cryptoquant.is_connected(),
        tradingview_connected: state.tradingview.is_connected(),
    };

    Json(HealthResponse {
        status: "ok",
        engine: "crypto-latency-engine",
        version: env!("CARGO_PKG_VERSION"),
        uptime_secs: uptime,
        paper_mode: state.config.paper_mode,
        feeds,
    })
}

#[derive(Serialize)]
struct PricesResponse {
    btc: Option<f64>,
    eth: Option<f64>,
    sol: Option<f64>,
    timestamp: String,
    contracts: Vec<ContractPrice>,
}

#[derive(Serialize)]
struct ContractPrice {
    token_id: String,
    asset: String,
    mid_price: f64,
    spread: f64,
}

async fn prices(State(state): State<Arc<AppState>>) -> Json<PricesResponse> {
    let btc = state.binance.get_price(CryptoAsset::BTC).map(|p| p.price);
    let eth = state.binance.get_price(CryptoAsset::ETH).map(|p| p.price);
    let sol = state.binance.get_price(CryptoAsset::SOL).map(|p| p.price);

    let contracts: Vec<ContractPrice> = state
        .polymarket
        .orderbooks
        .iter()
        .map(|entry| ContractPrice {
            token_id: entry.key().clone(),
            asset: "".to_string(),
            mid_price: entry.value().mid_price,
            spread: entry.value().spread,
        })
        .collect();

    Json(PricesResponse {
        btc,
        eth,
        sol,
        timestamp: Utc::now().to_rfc3339(),
        contracts,
    })
}

async fn signals(State(state): State<Arc<AppState>>) -> Json<Vec<Signal>> {
    let signals = state.recent_signals.lock().clone();
    Json(signals)
}

async fn trades(State(state): State<Arc<AppState>>) -> Json<Vec<Trade>> {
    Json(state.executor.get_trades())
}

#[derive(Serialize)]
struct PnlResponse {
    realized: f64,
    unrealized: f64,
    total: f64,
    daily_trades: u32,
    daily_pnl: f64,
}

async fn pnl(State(state): State<Arc<AppState>>) -> Json<PnlResponse> {
    let (realized, unrealized) = state.executor.get_pnl();
    let risk_state = state.risk.get_state();

    Json(PnlResponse {
        realized,
        unrealized,
        total: realized + unrealized,
        daily_trades: risk_state.daily_trades,
        daily_pnl: risk_state.daily_pnl,
    })
}

#[derive(Deserialize, Serialize)]
struct ConfigUpdate {
    paper_mode: Option<bool>,
    max_per_trade_pct: Option<f64>,
    daily_loss_cap_pct: Option<f64>,
    capital: Option<f64>,
    base_threshold: Option<f64>,
}

async fn update_config(
    State(_state): State<Arc<AppState>>,
    Json(update): Json<ConfigUpdate>,
) -> (StatusCode, Json<serde_json::Value>) {
    // Config updates would need interior mutability — for now, log and ack
    info!("Config update received: {:?}", serde_json::to_string(&update).unwrap_or_default());

    (
        StatusCode::OK,
        Json(serde_json::json!({ "status": "acknowledged" })),
    )
}

#[derive(Deserialize)]
struct MarketRegistration {
    contracts: Vec<ContractRegistration>,
}

#[derive(Deserialize)]
struct ContractRegistration {
    token_id: String,
    condition_id: Option<String>,
    question: String,
    asset: String,
    direction: String,
    strike_price: f64,
    expiry: String,
    expiry_minutes: Option<u32>,
}

async fn register_markets(
    State(state): State<Arc<AppState>>,
    Json(reg): Json<MarketRegistration>,
) -> (StatusCode, Json<serde_json::Value>) {
    let mut registered = 0;

    let contracts: Vec<CryptoContract> = reg
        .contracts
        .into_iter()
        .filter_map(|c| {
            let asset = CryptoAsset::from_str_loose(&c.asset)?;
            let direction = if c.direction.to_lowercase().contains("above") {
                Direction::Above
            } else {
                Direction::Below
            };
            let expiry = chrono::DateTime::parse_from_rfc3339(&c.expiry)
                .ok()?
                .with_timezone(&Utc);

            registered += 1;
            Some(CryptoContract {
                token_id: c.token_id,
                condition_id: c.condition_id.unwrap_or_default(),
                question: c.question,
                asset,
                direction,
                strike_price: c.strike_price,
                expiry,
                expiry_minutes: c.expiry_minutes.unwrap_or(15),
            })
        })
        .collect();

    state.polymarket.add_contracts(contracts).await;

    info!("Registered {registered} crypto contracts");

    (
        StatusCode::OK,
        Json(serde_json::json!({ "registered": registered })),
    )
}

async fn status(State(state): State<Arc<AppState>>) -> Json<EngineStatus> {
    let risk_state = state.risk.get_state();
    let uptime = state.start_time.elapsed().as_secs();

    Json(EngineStatus {
        running: true,
        paper_mode: state.config.paper_mode,
        uptime_secs: uptime,
        feeds: FeedStatus {
            binance_connected: state.binance.is_connected(),
            binance_last_price: state.binance.get_price(CryptoAsset::BTC).map(|p| p.price),
            polymarket_connected: state.polymarket.is_connected(),
            polymarket_books: state.polymarket.book_count(),
            cryptoquant_connected: state.cryptoquant.is_connected(),
            tradingview_connected: state.tradingview.is_connected(),
        },
        risk: risk_state.clone(),
        signals_today: state.recent_signals.lock().len() as u32,
        trades_today: risk_state.daily_trades,
        daily_pnl: risk_state.daily_pnl,
    })
}

#[derive(Serialize)]
struct LatencyResponse {
    total_trades_measured: usize,
    avg_signal_latency_us: f64,
    avg_execution_latency_us: f64,
    signal_latency_p50_us: u64,
    signal_latency_p95_us: u64,
    signal_latency_p99_us: u64,
    execution_latency_p50_us: u64,
    execution_latency_p95_us: u64,
    execution_latency_p99_us: u64,
}

fn percentile(sorted: &[u64], pct: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let idx = ((pct / 100.0) * (sorted.len() as f64 - 1.0)).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

async fn latency(State(state): State<Arc<AppState>>) -> Json<LatencyResponse> {
    let history = state.executor.get_latency_history();
    let total = history.len();

    if total == 0 {
        return Json(LatencyResponse {
            total_trades_measured: 0,
            avg_signal_latency_us: 0.0,
            avg_execution_latency_us: 0.0,
            signal_latency_p50_us: 0,
            signal_latency_p95_us: 0,
            signal_latency_p99_us: 0,
            execution_latency_p50_us: 0,
            execution_latency_p95_us: 0,
            execution_latency_p99_us: 0,
        });
    }

    let mut signal_latencies: Vec<u64> = history.iter().map(|r| r.signal_latency_us).collect();
    let mut exec_latencies: Vec<u64> = history.iter().map(|r| r.execution_latency_us).collect();
    signal_latencies.sort_unstable();
    exec_latencies.sort_unstable();

    let avg_signal = signal_latencies.iter().sum::<u64>() as f64 / total as f64;
    let avg_exec = exec_latencies.iter().sum::<u64>() as f64 / total as f64;

    Json(LatencyResponse {
        total_trades_measured: total,
        avg_signal_latency_us: avg_signal,
        avg_execution_latency_us: avg_exec,
        signal_latency_p50_us: percentile(&signal_latencies, 50.0),
        signal_latency_p95_us: percentile(&signal_latencies, 95.0),
        signal_latency_p99_us: percentile(&signal_latencies, 99.0),
        execution_latency_p50_us: percentile(&exec_latencies, 50.0),
        execution_latency_p95_us: percentile(&exec_latencies, 95.0),
        execution_latency_p99_us: percentile(&exec_latencies, 99.0),
    })
}

// ── Correlation endpoints ──

#[derive(Deserialize)]
struct CorrelationRegistration {
    pairs: Vec<CorrelationPairInput>,
}

#[derive(Deserialize)]
struct CorrelationPairInput {
    /// Unique ID for this pair. Auto-generated if absent.
    id: Option<String>,
    market_a_token: String,
    market_b_token: String,
    /// "subset", "superset", "mutually_exclusive", "complementary"
    relationship: String,
    label: Option<String>,
}

async fn register_correlations(
    State(state): State<Arc<AppState>>,
    Json(reg): Json<CorrelationRegistration>,
) -> (StatusCode, Json<serde_json::Value>) {
    let mut registered = 0u32;

    for (i, input) in reg.pairs.into_iter().enumerate() {
        let relationship = match input.relationship.to_lowercase().as_str() {
            "subset" => Relationship::Subset,
            "superset" => Relationship::Superset,
            "mutually_exclusive" => Relationship::MutuallyExclusive,
            "complementary" => Relationship::Complementary,
            other => {
                info!("Unknown relationship type: {other}, skipping");
                continue;
            }
        };

        let pair_id = input.id.unwrap_or_else(|| format!("corr-pair-{}", i));

        let pair = CorrelatedPair {
            id: pair_id,
            market_a_token: input.market_a_token,
            market_b_token: input.market_b_token,
            relationship,
            label: input.label,
        };

        if state.correlation_detector.add_pair(pair) {
            registered += 1;
        }
    }

    info!("Registered {registered} correlated pairs");

    (
        StatusCode::OK,
        Json(serde_json::json!({ "registered": registered })),
    )
}

async fn list_correlations(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<CorrelatedPair>> {
    Json(state.correlation_detector.get_pairs())
}

async fn correlation_signals(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<CorrelationSignal>> {
    let signals = state.recent_correlation_signals.lock().clone();
    Json(signals)
}
