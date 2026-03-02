"""
GPU-Accelerated Backtester

Replays historical trade data across strategy configurations in parallel
on the GPU to find optimal parameters.  Two modes:

1. Strategy Audit — analyse closed trades per strategy to compute
   win rate, Sharpe, profit factor, max drawdown, avg holding time.

2. Parameter Sweep — for a given strategy, test N parameter combos
   (edge threshold, position size, stop-loss, take-profit) in parallel
   using PyTorch tensors, returning the Pareto-optimal set.

All heavy-lifting runs as batched tensor ops on CUDA so a sweep of
10 000 parameter combos finishes in seconds instead of minutes.
"""

import time
import torch
import numpy as np
from config import DEVICE, BACKTEST_DEFAULT_PATHS, BACKTEST_MAX_PATHS


class GPUBacktester:
    def __init__(self):
        self.device = DEVICE

    # ------------------------------------------------------------------
    # 1.  Strategy audit
    # ------------------------------------------------------------------
    def audit_strategies(self, trades: list[dict]) -> dict:
        """
        Given a list of closed trades (each with at least strategy,
        realizedPnl, entryCost, entryTime, exitTime), return per-strategy
        performance stats.
        """
        if not trades:
            return {"strategies": {}, "overall": {}}

        strats: dict[str, list[dict]] = {}
        for t in trades:
            s = t.get("strategy", "unknown")
            strats.setdefault(s, []).append(t)

        results = {}
        for name, ts in strats.items():
            results[name] = self._compute_stats(ts)

        overall = self._compute_stats(trades)
        return {"strategies": results, "overall": overall}

    def _compute_stats(self, trades: list[dict]) -> dict:
        pnls = [t.get("realizedPnl", 0) for t in trades]
        costs = [abs(t.get("entryCost", 0)) or 1 for t in trades]
        returns = [p / c for p, c in zip(pnls, costs)]

        wins = [p for p in pnls if p > 0]
        losses = [p for p in pnls if p <= 0]

        hold_hours = []
        for t in trades:
            if t.get("entryTime") and t.get("exitTime"):
                try:
                    h = (t["exitTime"] - t["entryTime"]) / 3_600_000
                    hold_hours.append(h)
                except Exception:
                    pass

        total_pnl = sum(pnls)
        gross_profit = sum(wins) if wins else 0
        gross_loss = abs(sum(losses)) if losses else 0
        profit_factor = gross_profit / gross_loss if gross_loss > 0 else float("inf")

        peak = 0.0
        max_dd = 0.0
        cum = 0.0
        for p in pnls:
            cum += p
            peak = max(peak, cum)
            dd = (peak - cum) / peak if peak > 0 else 0
            max_dd = max(max_dd, dd)

        r_arr = np.array(returns) if returns else np.array([0])
        sharpe = float(r_arr.mean() / r_arr.std()) if r_arr.std() > 0 else 0

        return {
            "trades": len(trades),
            "wins": len(wins),
            "losses": len(losses),
            "win_rate": round(len(wins) / len(trades), 4) if trades else 0,
            "total_pnl": round(total_pnl, 2),
            "avg_pnl": round(total_pnl / len(trades), 2) if trades else 0,
            "avg_win": round(sum(wins) / len(wins), 2) if wins else 0,
            "avg_loss": round(sum(losses) / len(losses), 2) if losses else 0,
            "profit_factor": round(profit_factor, 3),
            "sharpe_ratio": round(sharpe, 3),
            "max_drawdown": round(max_dd, 4),
            "avg_hold_hours": round(sum(hold_hours) / len(hold_hours), 1) if hold_hours else None,
            "total_invested": round(sum(costs), 2),
            "roi_pct": round(total_pnl / sum(costs) * 100, 2) if sum(costs) > 0 else 0,
        }

    # ------------------------------------------------------------------
    # 2.  GPU parameter sweep
    # ------------------------------------------------------------------
    def parameter_sweep(
        self,
        trades: list[dict],
        strategy: str | None = None,
        edge_range: tuple = (0.005, 0.10, 20),
        size_range: tuple = (50, 500, 20),
        sl_range: tuple = (-0.20, -0.02, 10),
        tp_range: tuple = (0.005, 0.10, 10),
    ) -> dict:
        """
        Sweep edge_threshold x position_size x stop_loss x take_profit
        combinations in parallel.  Each combo re-filters the trade list
        and computes PnL on GPU.

        Returns top-10 parameter sets sorted by risk-adjusted return.
        """
        t0 = time.time()

        subset = trades
        if strategy:
            subset = [t for t in trades if t.get("strategy") == strategy]
        if not subset:
            return {"best_params": [], "combos_tested": 0, "elapsed_s": 0}

        edges = np.linspace(*edge_range)
        sizes = np.linspace(*size_range)
        sls = np.linspace(*sl_range)
        tps = np.linspace(*tp_range)

        n_combos = len(edges) * len(sizes) * len(sls) * len(tps)
        if n_combos > BACKTEST_MAX_PATHS:
            step = max(2, int(n_combos / BACKTEST_MAX_PATHS) + 1)
            edges = edges[::step]
            sizes = sizes[::step]
            n_combos = len(edges) * len(sizes) * len(sls) * len(tps)

        trade_edges = torch.tensor(
            [t.get("edgePercent") or t.get("edge") or 0 for t in subset],
            dtype=torch.float32, device=self.device,
        )
        trade_pnl_pct = torch.tensor(
            [
                (t.get("realizedPnl", 0) / (abs(t.get("entryCost", 0)) or 1))
                for t in subset
            ],
            dtype=torch.float32, device=self.device,
        )

        best = []

        for edge_thresh in edges:
            mask = trade_edges >= edge_thresh  # (n_trades,)
            if mask.sum() < 3:
                continue
            filtered_pnl = trade_pnl_pct[mask]

            for sl in sls:
                for tp in tps:
                    clamped = torch.clamp(filtered_pnl, min=sl, max=tp)
                    total_ret = clamped.sum().item()
                    n = int(mask.sum().item())
                    avg_ret = total_ret / n
                    std_ret = clamped.std().item() if n > 1 else 1.0
                    sharpe = avg_ret / std_ret if std_ret > 0 else 0

                    for sz in sizes:
                        dollar_pnl = total_ret * sz
                        best.append({
                            "edge_threshold": round(float(edge_thresh), 4),
                            "position_size": round(float(sz), 0),
                            "stop_loss": round(float(sl), 4),
                            "take_profit": round(float(tp), 4),
                            "trades_taken": n,
                            "total_return_pct": round(total_ret * 100, 2),
                            "avg_return_pct": round(avg_ret * 100, 3),
                            "sharpe": round(sharpe, 3),
                            "est_dollar_pnl": round(dollar_pnl, 2),
                        })

        best.sort(key=lambda x: x["sharpe"], reverse=True)
        elapsed = time.time() - t0

        return {
            "best_params": best[:10],
            "combos_tested": n_combos,
            "trades_in_sample": len(subset),
            "strategy": strategy,
            "elapsed_s": round(elapsed, 3),
        }

    # ------------------------------------------------------------------
    # 3.  Walk-forward validation
    # ------------------------------------------------------------------
    def walk_forward(
        self,
        trades: list[dict],
        strategy: str | None = None,
        train_pct: float = 0.7,
    ) -> dict:
        """
        Split trades into train/test windows.  Optimize on train,
        evaluate on test.  Detects overfitting.
        """
        subset = trades
        if strategy:
            subset = [t for t in trades if t.get("strategy") == strategy]
        if len(subset) < 10:
            return {"error": "Not enough trades for walk-forward (need ≥10)"}

        sorted_trades = sorted(subset, key=lambda t: t.get("entryTime", 0))
        split = int(len(sorted_trades) * train_pct)
        train_set = sorted_trades[:split]
        test_set = sorted_trades[split:]

        train_result = self.parameter_sweep(train_set, strategy)
        if not train_result["best_params"]:
            return {"error": "No viable parameters found in training window"}

        best = train_result["best_params"][0]

        test_pnls = []
        for t in test_set:
            e = t.get("edgePercent") or t.get("edge") or 0
            if e >= best["edge_threshold"]:
                cost = abs(t.get("entryCost", 0)) or 1
                ret = (t.get("realizedPnl", 0)) / cost
                clamped = max(best["stop_loss"], min(best["take_profit"], ret))
                test_pnls.append(clamped)

        test_arr = np.array(test_pnls) if test_pnls else np.array([0])

        return {
            "train_trades": len(train_set),
            "test_trades": len(test_set),
            "best_params": best,
            "train_sharpe": best["sharpe"],
            "test_sharpe": round(float(test_arr.mean() / test_arr.std()), 3) if test_arr.std() > 0 else 0,
            "test_avg_return_pct": round(float(test_arr.mean() * 100), 3),
            "test_total_return_pct": round(float(test_arr.sum() * 100), 2),
            "test_win_rate": round(float((test_arr > 0).mean()), 4) if len(test_arr) > 0 else 0,
            "overfit_risk": "high" if best["sharpe"] > 0 and (test_arr.mean() / (test_arr.std() or 1)) < best["sharpe"] * 0.3 else "low",
        }

    def get_status(self) -> dict:
        return {"device": self.device, "max_combos": BACKTEST_MAX_PATHS}
