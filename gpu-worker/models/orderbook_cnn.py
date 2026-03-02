"""
Orderbook Pattern Recognition CNN

Dual-path 1D CNN that processes bid and ask sides independently,
fuses their features, and classifies orderbook patterns.

Patterns detected:
  0 = neutral        — balanced book, no clear signal
  1 = accumulation   — large hidden bids building, absorption of sells
  2 = distribution   — large hidden asks building, absorption of buys
  3 = spoofing       — one-sided depth that evaporates (top-heavy concentration)
  4 = whale_entry    — sudden massive order on one side

Each orderbook side is a tensor of shape (levels, features):
  features per level = [price, size, cumulative_size, concentration]

The model also outputs a directional signal:
  0 = neutral, 1 = bullish, 2 = bearish

Training is self-supervised from trade outcomes: if a trade entered
after a detected pattern was profitable, that pattern+direction
combination gets reinforced.
"""

import os
import torch
import torch.nn as nn
import torch.nn.functional as F
import numpy as np

from config import (
    DEVICE, ORDERBOOK_MODEL_PATH, ORDERBOOK_LEVELS, ORDERBOOK_FEATURES,
)

PATTERN_NAMES = ["neutral", "accumulation", "distribution", "spoofing", "whale_entry"]
DIRECTION_NAMES = ["neutral", "bullish", "bearish"]


class BookEncoder(nn.Module):
    """Encodes one side (bid or ask) of the orderbook."""
    def __init__(self, n_features=ORDERBOOK_FEATURES, n_levels=ORDERBOOK_LEVELS):
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv1d(n_features, 32, kernel_size=3, padding=1),
            nn.BatchNorm1d(32),
            nn.GELU(),
            nn.Conv1d(32, 64, kernel_size=3, padding=1),
            nn.BatchNorm1d(64),
            nn.GELU(),
            nn.Conv1d(64, 64, kernel_size=3, padding=1),
            nn.BatchNorm1d(64),
            nn.GELU(),
            nn.AdaptiveAvgPool1d(1),
        )

    def forward(self, x):
        return self.conv(x).squeeze(-1)


class OrderbookNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.bid_encoder = BookEncoder()
        self.ask_encoder = BookEncoder()

        self.cross_attention = nn.MultiheadAttention(
            embed_dim=64, num_heads=4, batch_first=True,
        )

        self.fusion = nn.Sequential(
            nn.Linear(192, 128),
            nn.BatchNorm1d(128),
            nn.GELU(),
            nn.Dropout(0.3),
            nn.Linear(128, 64),
            nn.GELU(),
            nn.Dropout(0.2),
        )

        self.pattern_head = nn.Linear(64, len(PATTERN_NAMES))
        self.direction_head = nn.Linear(64, len(DIRECTION_NAMES))
        self.confidence_head = nn.Sequential(nn.Linear(64, 1), nn.Sigmoid())

    def forward(self, bid_book, ask_book):
        """
        bid_book, ask_book: (batch, features, levels)
        """
        bid_feat = self.bid_encoder(bid_book)      # (B, 64)
        ask_feat = self.ask_encoder(ask_book)      # (B, 64)

        # Cross-attention: let bid attend to ask and vice versa
        seq = torch.stack([bid_feat, ask_feat], dim=1)  # (B, 2, 64)
        attended, _ = self.cross_attention(seq, seq, seq)
        cross_feat = attended.mean(dim=1)           # (B, 64)

        combined = torch.cat([bid_feat, ask_feat, cross_feat], dim=1)  # (B, 192)
        fused = self.fusion(combined)

        pattern_logits = self.pattern_head(fused)
        direction_logits = self.direction_head(fused)
        confidence = self.confidence_head(fused).squeeze(-1)

        return pattern_logits, direction_logits, confidence


def _prepare_book_tensor(levels: list[dict], n_levels: int = ORDERBOOK_LEVELS) -> torch.Tensor:
    """
    Convert a list of {price, size} dicts into a (features, levels) tensor.
    Pads or truncates to n_levels.
    """
    arr = np.zeros((ORDERBOOK_FEATURES, n_levels), dtype=np.float32)
    cumulative = 0.0
    total_size = sum(l.get("size", 0) for l in levels[:n_levels]) or 1.0

    for i, level in enumerate(levels[:n_levels]):
        price = float(level.get("price", 0))
        size = float(level.get("size", 0))
        cumulative += size
        arr[0, i] = price
        arr[1, i] = size / (total_size or 1)  # normalized size
        arr[2, i] = cumulative / (total_size or 1)  # cumulative fraction
        arr[3, i] = size / (total_size or 1)  # concentration at this level

    return torch.tensor(arr)


class OrderbookPatternDetector:
    def __init__(self):
        self.model = OrderbookNet().to(DEVICE)
        self.optimizer = torch.optim.AdamW(self.model.parameters(), lr=5e-4, weight_decay=1e-4)
        self.train_count = 0
        self._load()

    def _load(self):
        if os.path.exists(ORDERBOOK_MODEL_PATH):
            try:
                ckpt = torch.load(ORDERBOOK_MODEL_PATH, map_location=DEVICE, weights_only=False)
                self.model.load_state_dict(ckpt["model"])
                self.train_count = ckpt.get("train_count", 0)
            except Exception as e:
                print(f"[OrderbookCNN] Could not load checkpoint: {e}")

    def save(self):
        os.makedirs(os.path.dirname(ORDERBOOK_MODEL_PATH), exist_ok=True)
        torch.save({
            "model": self.model.state_dict(),
            "train_count": self.train_count,
        }, ORDERBOOK_MODEL_PATH)

    @torch.no_grad()
    def predict(self, orderbooks: list[dict]) -> list[dict]:
        """
        Each orderbook: {bids: [{price, size}, ...], asks: [{price, size}, ...]}
        Returns: [{pattern, direction, confidence, pattern_probs, direction_probs}]
        """
        if not orderbooks:
            return []

        self.model.eval()
        bids_batch, asks_batch = [], []

        for ob in orderbooks:
            bids_batch.append(_prepare_book_tensor(ob.get("bids") or []))
            asks_batch.append(_prepare_book_tensor(ob.get("asks") or []))

        bid_t = torch.stack(bids_batch).to(DEVICE)
        ask_t = torch.stack(asks_batch).to(DEVICE)

        pattern_logits, direction_logits, confidence = self.model(bid_t, ask_t)

        pattern_probs = F.softmax(pattern_logits, dim=-1).cpu().numpy()
        direction_probs = F.softmax(direction_logits, dim=-1).cpu().numpy()
        conf_np = confidence.cpu().numpy()

        results = []
        for i in range(len(orderbooks)):
            p_idx = int(pattern_probs[i].argmax())
            d_idx = int(direction_probs[i].argmax())
            results.append({
                "pattern": PATTERN_NAMES[p_idx],
                "pattern_confidence": float(pattern_probs[i][p_idx]),
                "direction": DIRECTION_NAMES[d_idx],
                "direction_confidence": float(direction_probs[i][d_idx]),
                "confidence": float(conf_np[i]),
                "pattern_probs": {n: float(pattern_probs[i][j]) for j, n in enumerate(PATTERN_NAMES)},
                "direction_probs": {n: float(direction_probs[i][j]) for j, n in enumerate(DIRECTION_NAMES)},
                "edge_adjustment": self._compute_edge_adjustment(
                    PATTERN_NAMES[p_idx], DIRECTION_NAMES[d_idx], float(conf_np[i])
                ),
            })
        return results

    def _compute_edge_adjustment(self, pattern: str, direction: str, confidence: float) -> float:
        """
        Translate pattern + direction into an edge multiplier.
        Positive = boost edge, negative = reduce edge.
        """
        base = 0.0
        if pattern == "accumulation":
            base = 0.02 if direction == "bullish" else -0.01
        elif pattern == "distribution":
            base = 0.02 if direction == "bearish" else -0.01
        elif pattern == "whale_entry":
            base = 0.025
        elif pattern == "spoofing":
            base = -0.015
        return round(base * confidence, 4)

    def train_online(self, samples: list[dict]) -> dict:
        """
        Each sample: {bids, asks, pattern_label (int), direction_label (int), outcome (0 or 1)}
        """
        if not samples:
            return {"trained": 0}

        self.model.train()
        bids_batch, asks_batch, plabels, dlabels = [], [], [], []

        for s in samples:
            bids_batch.append(_prepare_book_tensor(s.get("bids") or []))
            asks_batch.append(_prepare_book_tensor(s.get("asks") or []))
            plabels.append(s.get("pattern_label", 0))
            dlabels.append(s.get("direction_label", 0))

        bid_t = torch.stack(bids_batch).to(DEVICE)
        ask_t = torch.stack(asks_batch).to(DEVICE)
        pt = torch.tensor(plabels, dtype=torch.long, device=DEVICE)
        dt = torch.tensor(dlabels, dtype=torch.long, device=DEVICE)

        pattern_logits, direction_logits, _ = self.model(bid_t, ask_t)
        loss = F.cross_entropy(pattern_logits, pt) + F.cross_entropy(direction_logits, dt)

        self.optimizer.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(self.model.parameters(), 1.0)
        self.optimizer.step()

        self.train_count += len(samples)
        if self.train_count % 20 == 0:
            self.save()

        return {"trained": len(samples), "loss": float(loss.item()), "total": self.train_count}

    def get_status(self) -> dict:
        return {
            "model": "OrderbookNet",
            "device": DEVICE,
            "parameters": sum(p.numel() for p in self.model.parameters()),
            "train_count": self.train_count,
            "patterns": PATTERN_NAMES,
        }
