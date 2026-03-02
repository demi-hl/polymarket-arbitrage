"""
GPU Worker — FastAPI Server

Exposes all five ML/compute models over HTTP so the MacBook bot can
offload heavy work to the PC's i9 + 3080 Ti.

Endpoints:
  POST /predict/edge          — deep learning edge prediction
  POST /predict/sentiment     — LLM + RoBERTa sentiment analysis
  POST /predict/orderbook     — CNN orderbook pattern detection
  POST /backtest              — strategy audit & parameter sweep
  POST /backtest/walk-forward — walk-forward validation
  POST /risk/monte-carlo      — portfolio Monte Carlo simulation
  POST /risk/stress-test      — stress test scenarios
  POST /train/edge            — online training for edge predictor
  POST /train/orderbook       — online training for orderbook CNN
  GET  /health                — server & model health check
  GET  /status                — detailed model status
"""

import time, os, sys
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Add parent to path so config is importable
sys.path.insert(0, os.path.dirname(__file__))

from config import HOST, PORT, DEVICE
from models import (
    EdgePredictor,
    SentimentEngine,
    OrderbookPatternDetector,
    GPUBacktester,
    MonteCarloRiskSimulator,
)

edge_predictor: EdgePredictor
sentiment_engine: SentimentEngine
orderbook_detector: OrderbookPatternDetector
backtester: GPUBacktester
monte_carlo: MonteCarloRiskSimulator
start_time: float


@asynccontextmanager
async def lifespan(app: FastAPI):
    global edge_predictor, sentiment_engine, orderbook_detector
    global backtester, monte_carlo, start_time

    start_time = time.time()
    print(f"\n{'='*50}")
    print(f"  GPU WORKER — starting on {DEVICE.upper()}")
    print(f"{'='*50}\n")

    edge_predictor = EdgePredictor()
    print(f"  [1/5] Edge Predictor loaded ({edge_predictor.get_status()['parameters']:,} params)")

    sentiment_engine = SentimentEngine()
    sentiment_engine.load_fast()
    print(f"  [2/5] Sentiment Engine — fast tier loaded")
    # Deep tier loads on first request to save VRAM at startup

    orderbook_detector = OrderbookPatternDetector()
    print(f"  [3/5] Orderbook CNN loaded ({orderbook_detector.get_status()['parameters']:,} params)")

    backtester = GPUBacktester()
    print(f"  [4/5] GPU Backtester ready")

    monte_carlo = MonteCarloRiskSimulator()
    print(f"  [5/5] Monte Carlo Simulator ready")

    if DEVICE == "cuda":
        import torch
        vram = torch.cuda.memory_allocated() / 1e9
        total = torch.cuda.get_device_properties(0).total_mem / 1e9
        print(f"\n  VRAM: {vram:.1f} / {total:.1f} GB used")
        print(f"  GPU:  {torch.cuda.get_device_name(0)}")

    print(f"\n  Listening on http://{HOST}:{PORT}")
    print(f"{'='*50}\n")

    yield


app = FastAPI(title="Polymarket GPU Worker", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request / Response models ────────────────────────────────────────

class EdgeRequest(BaseModel):
    opportunities: list[dict]

class SentimentRequest(BaseModel):
    items: list[dict] = Field(
        ...,
        description="Each item: {text, market_question?, depth: 'fast'|'deep'}",
    )

class OrderbookRequest(BaseModel):
    orderbooks: list[dict] = Field(
        ...,
        description="Each: {bids: [{price,size},...], asks: [{price,size},...]}",
    )

class BacktestRequest(BaseModel):
    trades: list[dict]
    strategy: str | None = None

class SweepRequest(BaseModel):
    trades: list[dict]
    strategy: str | None = None
    edge_range: tuple = (0.005, 0.10, 20)
    size_range: tuple = (50, 500, 20)
    sl_range: tuple = (-0.20, -0.02, 10)
    tp_range: tuple = (0.005, 0.10, 10)

class WalkForwardRequest(BaseModel):
    trades: list[dict]
    strategy: str | None = None
    train_pct: float = 0.7

class MonteCarloRequest(BaseModel):
    positions: list[dict]
    bankroll: float = 10000
    n_paths: int = 50000
    horizon_days: int = 30

class StressTestRequest(BaseModel):
    positions: list[dict]
    bankroll: float = 10000
    scenarios: list[dict] | None = None

class TrainEdgeRequest(BaseModel):
    trades: list[dict]

class TrainOrderbookRequest(BaseModel):
    samples: list[dict]


# ── Endpoints ────────────────────────────────────────────────────────

@app.post("/predict/edge")
async def predict_edge(req: EdgeRequest):
    try:
        results = edge_predictor.predict(req.opportunities)
        return {"predictions": results, "count": len(results)}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/predict/sentiment")
async def predict_sentiment(req: SentimentRequest):
    try:
        results = sentiment_engine.analyze_batch(req.items)
        return {"results": results, "count": len(results)}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/predict/orderbook")
async def predict_orderbook(req: OrderbookRequest):
    try:
        results = orderbook_detector.predict(req.orderbooks)
        return {"predictions": results, "count": len(results)}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/backtest")
async def run_backtest(req: BacktestRequest):
    try:
        audit = backtester.audit_strategies(req.trades)
        sweep = backtester.parameter_sweep(req.trades, req.strategy)
        return {"audit": audit, "sweep": sweep}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/backtest/sweep")
async def run_sweep(req: SweepRequest):
    try:
        result = backtester.parameter_sweep(
            req.trades, req.strategy,
            edge_range=req.edge_range, size_range=req.size_range,
            sl_range=req.sl_range, tp_range=req.tp_range,
        )
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/backtest/walk-forward")
async def run_walk_forward(req: WalkForwardRequest):
    try:
        result = backtester.walk_forward(req.trades, req.strategy, req.train_pct)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/risk/monte-carlo")
async def run_monte_carlo(req: MonteCarloRequest):
    try:
        result = monte_carlo.simulate_portfolio(
            req.positions, req.bankroll, req.n_paths, req.horizon_days,
        )
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/risk/stress-test")
async def run_stress_test(req: StressTestRequest):
    try:
        result = monte_carlo.stress_test(req.positions, req.bankroll, req.scenarios)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/train/edge")
async def train_edge(req: TrainEdgeRequest):
    try:
        result = edge_predictor.train_online(req.trades)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/train/orderbook")
async def train_orderbook(req: TrainOrderbookRequest):
    try:
        result = orderbook_detector.train_online(req.samples)
        return result
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "device": DEVICE,
        "uptime_s": round(time.time() - start_time, 1),
    }


@app.get("/status")
async def status():
    import torch
    gpu_info = {}
    if DEVICE == "cuda":
        gpu_info = {
            "gpu_name": torch.cuda.get_device_name(0),
            "vram_total_gb": round(torch.cuda.get_device_properties(0).total_mem / 1e9, 2),
            "vram_used_gb": round(torch.cuda.memory_allocated() / 1e9, 2),
            "vram_cached_gb": round(torch.cuda.memory_reserved() / 1e9, 2),
        }

    return {
        "device": DEVICE,
        "uptime_s": round(time.time() - start_time, 1),
        **gpu_info,
        "models": {
            "edge_predictor": edge_predictor.get_status(),
            "sentiment": sentiment_engine.get_status(),
            "orderbook_cnn": orderbook_detector.get_status(),
            "backtester": backtester.get_status(),
            "monte_carlo": monte_carlo.get_status(),
        },
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host=HOST, port=PORT, reload=False, workers=1)
