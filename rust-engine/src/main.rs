mod api;
mod config;
mod correlation;
mod detector;
mod executor;
mod feeds;
mod models;
mod precompute;
mod risk;
mod signer;
mod trend;

use config::Config;
use correlation::CorrelationDetector;
use detector::DivergenceDetector;
use executor::OrderExecutor;
use feeds::binance::BinanceFeed;
use feeds::cryptoquant::CryptoQuantFeed;
use feeds::polymarket::PolymarketFeed;
use feeds::tradingview::TradingViewFeed;
use models::{CorrelationSignal, Signal};
use precompute::ProbabilityCache;
use risk::RiskManager;
use signer::OrderSigner;
use std::sync::Arc;
use std::time::Instant;
use tokio::net::TcpListener;
use tracing::{error, info, warn};

pub struct AppState {
    pub config: Config,
    pub binance: Arc<BinanceFeed>,
    pub polymarket: Arc<PolymarketFeed>,
    pub cryptoquant: Arc<CryptoQuantFeed>,
    pub tradingview: Arc<TradingViewFeed>,
    pub executor: Arc<OrderExecutor>,
    pub risk: Arc<RiskManager>,
    pub correlation_detector: Arc<CorrelationDetector>,
    pub prob_cache: Arc<ProbabilityCache>,
    pub recent_signals: Arc<parking_lot::Mutex<Vec<Signal>>>,
    pub recent_correlation_signals: parking_lot::Mutex<Vec<CorrelationSignal>>,
    pub start_time: Instant,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "crypto_latency_engine=info,tower_http=info".into()),
        )
        .init();

    let config = Config::from_env();

    info!("=== Crypto Latency Arbitrage Engine ===");
    info!("Mode: {}", if config.paper_mode { "PAPER" } else { "LIVE" });
    info!("Capital: ${:.2}", config.risk.capital);
    info!("Risk: {:.1}% per trade, {:.1}% daily cap",
        config.risk.max_per_trade_pct * 100.0,
        config.risk.daily_loss_cap_pct * 100.0,
    );
    info!("API port: {}", config.api_port);

    let binance = Arc::new(BinanceFeed::new(&config.binance_ws_url));
    let polymarket = Arc::new(PolymarketFeed::new(&config.polymarket_ws_url));
    let cryptoquant = Arc::new(CryptoQuantFeed::new());
    let tradingview = Arc::new(TradingViewFeed::new());
    let risk = Arc::new(RiskManager::new(config.clone()));

    let signer = config
        .private_key
        .as_ref()
        .and_then(|key| {
            OrderSigner::new(key)
                .map_err(|e| error!("Failed to create signer: {e}"))
                .ok()
        })
        .map(Arc::new);

    if signer.is_none() && !config.paper_mode {
        warn!("No private key configured — forcing paper mode");
    }

    let executor = Arc::new(OrderExecutor::new(
        config.clone(),
        risk.clone(),
        signer,
    ));
    executor.load_trades();

    let correlation_detector = Arc::new(CorrelationDetector::new(config.clone()));
    let prob_cache = Arc::new(ProbabilityCache::new(config.clone()));

    // Load persisted trades from disk (#4)
    executor.load_trades();

    let state = Arc::new(AppState {
        config: config.clone(),
        binance: binance.clone(),
        polymarket: polymarket.clone(),
        cryptoquant: cryptoquant.clone(),
        tradingview: tradingview.clone(),
        executor: executor.clone(),
        risk: risk.clone(),
        correlation_detector: correlation_detector.clone(),
        prob_cache: prob_cache.clone(),
        recent_signals: Arc::new(parking_lot::Mutex::new(Vec::new())),
        recent_correlation_signals: parking_lot::Mutex::new(Vec::new()),
        start_time: Instant::now(),
    });

    // Spawn all feed tasks
    let binance_handle = binance.clone();
    tokio::spawn(async move { binance_handle.run().await });

    let poly_handle = polymarket.clone();
    tokio::spawn(async move { poly_handle.run().await });

    let cq_handle = cryptoquant.clone();
    tokio::spawn(async move { cq_handle.run().await });

    let tv_handle = tradingview.clone();
    tokio::spawn(async move { tv_handle.run().await });

    // Spawn event-driven probability computation (reacts to price/book changes instantly)
    {
        let pc = state.prob_cache.clone();
        let pc_binance = state.binance.clone();
        let pc_poly = state.polymarket.clone();
        let pc_cq = state.cryptoquant.clone();
        let pc_tv = state.tradingview.clone();
        let pc_exec = state.executor.clone();
        let pc_risk = state.risk.clone();
        let pc_signals = state.recent_signals.clone();
        tokio::spawn(async move {
            pc.run(pc_binance, pc_poly, pc_cq, pc_tv, pc_exec, pc_risk, pc_signals).await;
        });
    }

    // Spawn the detection + execution loop (kept as fallback safety net)
    let det_state = state.clone();
    tokio::spawn(async move {
        detection_loop(det_state).await;
    });

    // Spawn periodic trade persistence (every 30s) (#4)
    let persist_executor = executor.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            interval.tick().await;
            persist_executor.save_trades();
        }
    });

    // Spawn daily risk reset (at 00:00 UTC)
    let risk_handle = risk.clone();
    tokio::spawn(async move {
        daily_reset_loop(risk_handle).await;
    });

    // Start HTTP API
    let router = api::create_router(state);
    let addr = format!("0.0.0.0:{}", config.api_port);
    info!("API listening on {addr}");

    let listener = TcpListener::bind(&addr).await.expect("Failed to bind API port");
    axum::serve(listener, router)
        .await
        .expect("API server failed");
}

async fn detection_loop(state: Arc<AppState>) {
    let mut detector = DivergenceDetector::new(state.config.clone());

    // Wait for Binance to connect
    info!("Waiting for Binance feed...");
    loop {
        if state.binance.is_connected() {
            info!("Binance feed connected");
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    let mut interval = tokio::time::interval(std::time::Duration::from_millis(100));
    let mut scan_count = 0u64;

    loop {
        interval.tick().await;
        scan_count += 1;

        // Update trend from latest Binance prices
        for asset in &[models::CryptoAsset::BTC, models::CryptoAsset::ETH, models::CryptoAsset::SOL] {
            if let Some(price) = state.binance.get_price(*asset) {
                detector.update_trend(asset.binance_symbol(), price.price);
            }
        }

        let contracts = state.polymarket.contracts.read().await;
        if contracts.is_empty() {
            if scan_count % 100 == 0 {
                info!(
                    "No contracts registered yet. BTC={} ETH={} SOL={}",
                    state.binance.get_price(models::CryptoAsset::BTC)
                        .map(|p| format!("${:.2}", p.price))
                        .unwrap_or_else(|| "N/A".to_string()),
                    state.binance.get_price(models::CryptoAsset::ETH)
                        .map(|p| format!("${:.2}", p.price))
                        .unwrap_or_else(|| "N/A".to_string()),
                    state.binance.get_price(models::CryptoAsset::SOL)
                        .map(|p| format!("${:.2}", p.price))
                        .unwrap_or_else(|| "N/A".to_string()),
                );
            }
            continue;
        }

        let signals = detector.scan(
            &state.binance,
            &state.polymarket,
            &state.cryptoquant,
            &state.tradingview,
            &contracts,
        );

        if !signals.is_empty() {
            {
                let mut recent = state.recent_signals.lock();
                for signal in &signals {
                    recent.push(signal.clone());
                }
                if recent.len() > 1000 {
                    let drain = recent.len() - 1000;
                    recent.drain(..drain);
                }
            }

            for signal in &signals {
                match state.executor.execute(signal).await {
                    Ok(trade) => {
                        info!("Trade executed: {} {:?} status={:?}",
                            trade.id, trade.side, trade.status);
                    }
                    Err(e) => {
                        warn!("Trade execution failed: {e}");
                    }
                }
            }
        }

        // Correlation scan — runs every tick alongside divergence detection
        let corr_signals = state.correlation_detector.scan(&state.polymarket);
        if !corr_signals.is_empty() {
            {
                let mut recent = state.recent_correlation_signals.lock();
                for sig in &corr_signals {
                    recent.push(sig.clone());
                }
                if recent.len() > 500 {
                    let drain = recent.len() - 500;
                    recent.drain(..drain);
                }
            }

            for corr_sig in &corr_signals {
                match state.executor.execute_correlation(corr_sig).await {
                    Ok(trades) => {
                        for trade in &trades {
                            info!(
                                "Corr trade executed: {} {:?} status={:?}",
                                trade.id, trade.side, trade.status
                            );
                        }
                    }
                    Err(e) => {
                        warn!("Corr trade execution failed: {e}");
                    }
                }
            }
        }

        // Log periodic status
        if scan_count % 150 == 0 {
            let risk_state = state.risk.get_state();
            let (realized, _) = state.executor.get_pnl();
            info!(
                "STATUS: scans={scan_count} trades={} pnl=${:.2} positions={} halted={}",
                risk_state.daily_trades, realized, risk_state.open_positions, risk_state.halted,
            );
        }
    }
}

async fn daily_reset_loop(risk: Arc<RiskManager>) {
    loop {
        let now = chrono::Utc::now();
        let tomorrow = (now + chrono::Duration::days(1))
            .date_naive()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        let until_midnight = tomorrow
            .and_utc()
            .signed_duration_since(now)
            .to_std()
            .unwrap_or(std::time::Duration::from_secs(3600));

        tokio::time::sleep(until_midnight).await;
        risk.reset_daily();
    }
}
