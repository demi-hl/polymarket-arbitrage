"""
Deep Learning Edge Predictor

Multi-layer neural network that predicts trade win probability from
market features. Replaces the simple logistic regression with:
  - Learned embeddings for strategy type and market category
  - Residual connections through 3 hidden layers
  - Batch normalization + dropout for generalization
  - Online gradient descent for continuous learning from trade outcomes
  - Automatic checkpointing to disk

Input features (14 continuous + 2 categorical):
  edge_percent, log_liquidity, log_volume, hours_to_expiry, spread_cost,
  price_yes, price_no, confidence, volatility, flow_strength, oracle_boost,
  n_outcomes, bid_ask_ratio, price_momentum,
  strategy_idx (embedded), category_idx (embedded)

Output: win probability [0, 1]
"""

import os, json, time
import torch
import torch.nn as nn
import torch.nn.functional as F
import numpy as np
from config import (
    DEVICE, DTYPE, EDGE_MODEL_PATH, EDGE_HIDDEN_DIM,
    EDGE_N_STRATEGIES, EDGE_N_CATEGORIES, EDGE_EMBED_DIM, EDGE_LR,
)

N_CONTINUOUS = 14

STRATEGY_MAP = {
    "resolution-frontrun": 0, "multi-outcome-arb": 1, "basic-arbitrage": 2,
    "resolution-arbitrage": 3, "kalshi-arbitrage": 4, "predictit-arbitrage": 5,
    "manifold-arbitrage": 6, "metaculus-arbitrage": 7, "three-way-arbitrage": 8,
    "value-betting": 9, "market-maker": 10, "orderbook-scalper": 11,
    "correlated-market-arb": 12, "neg-risk-spread-arb": 13,
    "volume-spike-detector": 14, "ta-momentum": 15, "liquidity-sniper": 16,
    "event-catalyst": 17, "smart-money-detector": 18, "news-sentiment": 19,
}

CATEGORY_MAP: dict[str, int] = {}
_next_cat_id = [0]


def _get_category_id(cat: str) -> int:
    key = (cat or "unknown").lower().strip()[:64]
    if key not in CATEGORY_MAP:
        CATEGORY_MAP[key] = _next_cat_id[0] % EDGE_N_CATEGORIES
        _next_cat_id[0] += 1
    return CATEGORY_MAP[key]


class ResidualBlock(nn.Module):
    def __init__(self, dim, dropout=0.3):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(dim, dim),
            nn.BatchNorm1d(dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(dim, dim),
            nn.BatchNorm1d(dim),
        )

    def forward(self, x):
        return F.gelu(x + self.net(x))


class EdgeNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.strategy_emb = nn.Embedding(EDGE_N_STRATEGIES, EDGE_EMBED_DIM)
        self.category_emb = nn.Embedding(EDGE_N_CATEGORIES, EDGE_EMBED_DIM)

        input_dim = N_CONTINUOUS + EDGE_EMBED_DIM * 2

        self.input_proj = nn.Sequential(
            nn.Linear(input_dim, EDGE_HIDDEN_DIM),
            nn.BatchNorm1d(EDGE_HIDDEN_DIM),
            nn.GELU(),
            nn.Dropout(0.2),
        )
        self.res1 = ResidualBlock(EDGE_HIDDEN_DIM, dropout=0.3)
        self.res2 = ResidualBlock(EDGE_HIDDEN_DIM, dropout=0.2)
        self.res3 = ResidualBlock(EDGE_HIDDEN_DIM, dropout=0.1)
        self.head = nn.Sequential(
            nn.Linear(EDGE_HIDDEN_DIM, 32),
            nn.GELU(),
            nn.Linear(32, 1),
        )

    def forward(self, continuous, strategy_idx, category_idx):
        s = self.strategy_emb(strategy_idx)
        c = self.category_emb(category_idx)
        x = torch.cat([continuous, s, c], dim=1)
        x = self.input_proj(x)
        x = self.res1(x)
        x = self.res2(x)
        x = self.res3(x)
        return torch.sigmoid(self.head(x)).squeeze(-1)


def _extract_features(opp: dict) -> tuple[list[float], int, int]:
    """Convert a raw opportunity dict into model-ready features."""
    edge = opp.get("edgePercent") or opp.get("edge") or 0
    liq = opp.get("liquidity") or 0
    vol = opp.get("volume") or 0
    hours = 720.0
    if opp.get("endDate"):
        try:
            from datetime import datetime
            end = datetime.fromisoformat(opp["endDate"].replace("Z", "+00:00"))
            hours = max(0, (end.timestamp() - time.time()) / 3600)
        except Exception:
            pass

    continuous = [
        edge * 100,
        np.log10(max(liq, 1)),
        np.log10(max(vol, 1)),
        min(hours, 720) / 720,
        opp.get("spreadCost") or opp.get("slippageCost") or 0,
        opp.get("yesPrice") or opp.get("priceYes") or 0.5,
        opp.get("noPrice") or opp.get("priceNo") or 0.5,
        opp.get("confidence") or 0.5,
        opp.get("volatility") or 0,
        opp.get("flowStrength") or 0,
        opp.get("oracleBoost") or 0,
        opp.get("nOutcomes") or 2,
        opp.get("bidAskRatio") or 1.0,
        opp.get("priceMomentum") or 0,
    ]

    strat = STRATEGY_MAP.get(opp.get("strategy", ""), len(STRATEGY_MAP) - 1)
    cat = _get_category_id(opp.get("category") or opp.get("eventTitle"))
    return continuous, strat, cat


class EdgePredictor:
    def __init__(self):
        self.model = EdgeNet().to(DEVICE)
        self.optimizer = torch.optim.AdamW(self.model.parameters(), lr=EDGE_LR, weight_decay=1e-4)
        self.criterion = nn.BCELoss()
        self.train_count = 0
        self._load()

    def _load(self):
        if os.path.exists(EDGE_MODEL_PATH):
            try:
                ckpt = torch.load(EDGE_MODEL_PATH, map_location=DEVICE, weights_only=False)
                self.model.load_state_dict(ckpt["model"])
                self.optimizer.load_state_dict(ckpt["optimizer"])
                self.train_count = ckpt.get("train_count", 0)
            except Exception as e:
                print(f"[EdgePredictor] Could not load checkpoint: {e}")

    def save(self):
        os.makedirs(os.path.dirname(EDGE_MODEL_PATH), exist_ok=True)
        torch.save({
            "model": self.model.state_dict(),
            "optimizer": self.optimizer.state_dict(),
            "train_count": self.train_count,
        }, EDGE_MODEL_PATH)

    @torch.no_grad()
    def predict(self, opportunities: list[dict]) -> list[dict]:
        if not opportunities:
            return []
        self.model.eval()
        conts, strats, cats = [], [], []
        for opp in opportunities:
            c, s, cat = _extract_features(opp)
            conts.append(c)
            strats.append(s)
            cats.append(cat)

        ct = torch.tensor(conts, dtype=torch.float32, device=DEVICE)
        st = torch.tensor(strats, dtype=torch.long, device=DEVICE)
        ca = torch.tensor(cats, dtype=torch.long, device=DEVICE)

        probs = self.model(ct, st, ca).cpu().numpy()

        results = []
        for opp, prob in zip(opportunities, probs):
            p = float(prob)
            results.append({
                **opp,
                "gpuWinProb": p,
                "gpuConfidence": p,
                "gpuAdjustedEdge": (opp.get("edgePercent") or 0) * (0.4 + p * 1.2),
            })
        return sorted(results, key=lambda x: x["gpuAdjustedEdge"], reverse=True)

    def train_online(self, trades: list[dict]) -> dict:
        if not trades:
            return {"trained": 0}
        self.model.train()
        conts, strats, cats, labels = [], [], [], []
        for t in trades:
            c, s, cat = _extract_features(t)
            conts.append(c)
            strats.append(s)
            cats.append(cat)
            labels.append(1.0 if (t.get("realizedPnl") or 0) > 0 else 0.0)

        ct = torch.tensor(conts, dtype=torch.float32, device=DEVICE)
        st = torch.tensor(strats, dtype=torch.long, device=DEVICE)
        ca = torch.tensor(cats, dtype=torch.long, device=DEVICE)
        lb = torch.tensor(labels, dtype=torch.float32, device=DEVICE)

        pred = self.model(ct, st, ca)
        loss = self.criterion(pred, lb)

        self.optimizer.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(self.model.parameters(), 1.0)
        self.optimizer.step()

        self.train_count += len(trades)
        if self.train_count % 10 == 0:
            self.save()

        return {
            "trained": len(trades),
            "loss": float(loss.item()),
            "total_samples": self.train_count,
        }

    def get_status(self) -> dict:
        return {
            "model": "EdgeNet",
            "device": DEVICE,
            "parameters": sum(p.numel() for p in self.model.parameters()),
            "train_count": self.train_count,
            "checkpoint_exists": os.path.exists(EDGE_MODEL_PATH),
        }
