"""
Monte Carlo Risk Simulator

GPU-parallel portfolio simulation that runs N random paths forward
in time, modelling each open position's outcome as a Bernoulli trial
weighted by its estimated edge and win probability.

Outputs:
  - Value-at-Risk (VaR) at 95% and 99% confidence
  - Conditional VaR (Expected Shortfall)
  - Optimal Kelly fraction per strategy
  - Expected max drawdown distribution
  - Position sizing recommendations that respect a target risk budget

All random sampling and cumulative-sum operations run as batched
tensor ops on CUDA, making 50k-path simulations complete in <1s.
"""

import time
import torch
import numpy as np
from config import DEVICE, MC_DEFAULT_PATHS, MC_MAX_PATHS, MC_CONFIDENCE_LEVELS


class MonteCarloRiskSimulator:
    def __init__(self):
        self.device = DEVICE

    def simulate_portfolio(
        self,
        positions: list[dict],
        bankroll: float = 10000,
        n_paths: int = MC_DEFAULT_PATHS,
        horizon_days: int = 30,
    ) -> dict:
        """
        Simulate portfolio evolution over `horizon_days`.

        Each position: {
          entryCost, edgePercent, confidence (win prob),
          strategy, direction, daysToExpiry
        }
        """
        t0 = time.time()
        n_paths = min(n_paths, MC_MAX_PATHS)

        if not positions:
            return self._empty_result(bankroll)

        n_pos = len(positions)
        edges = torch.tensor(
            [p.get("edgePercent") or p.get("edge") or 0.02 for p in positions],
            dtype=torch.float32, device=self.device,
        )
        win_probs = torch.tensor(
            [p.get("confidence") or 0.55 for p in positions],
            dtype=torch.float32, device=self.device,
        )
        costs = torch.tensor(
            [abs(p.get("entryCost") or p.get("size") or 100) for p in positions],
            dtype=torch.float32, device=self.device,
        )
        days_to_exp = torch.tensor(
            [min(p.get("daysToExpiry") or horizon_days, horizon_days) for p in positions],
            dtype=torch.float32, device=self.device,
        )

        # Bernoulli outcomes per path: (n_paths, n_pos)
        # Each position resolves once, at a random time within its expiry window
        outcomes = torch.bernoulli(win_probs.unsqueeze(0).expand(n_paths, -1))
        # PnL per position: win = +edge * cost, lose = -cost * (1 - edge)
        pnl_win = edges * costs
        pnl_lose = -costs * (1 - edges).clamp(min=0.1)
        position_pnl = torch.where(outcomes == 1, pnl_win, pnl_lose)  # (n_paths, n_pos)

        # Assign resolution day per position per path
        resolve_day = torch.rand(n_paths, n_pos, device=self.device) * days_to_exp.unsqueeze(0)
        resolve_day = resolve_day.long().clamp(0, horizon_days - 1)

        # Build daily PnL matrix: (n_paths, horizon_days)
        daily_pnl = torch.zeros(n_paths, horizon_days, device=self.device)
        for d in range(horizon_days):
            mask = resolve_day == d
            daily_pnl[:, d] = (position_pnl * mask.float()).sum(dim=1)

        # Cumulative equity curves
        equity_curves = bankroll + daily_pnl.cumsum(dim=1)  # (n_paths, horizon_days)

        # Terminal values
        terminal = equity_curves[:, -1]  # (n_paths,)
        terminal_np = terminal.cpu().numpy()

        # VaR and CVaR
        var_results = {}
        for conf in MC_CONFIDENCE_LEVELS:
            pct = (1 - conf) * 100
            var_val = float(np.percentile(terminal_np - bankroll, pct))
            cvar_mask = terminal_np - bankroll <= var_val
            cvar_val = float(terminal_np[cvar_mask].mean() - bankroll) if cvar_mask.any() else var_val
            var_results[f"VaR_{int(conf*100)}"] = round(var_val, 2)
            var_results[f"CVaR_{int(conf*100)}"] = round(cvar_val, 2)

        # Max drawdown per path
        running_peak = equity_curves.cummax(dim=1).values
        drawdowns = (running_peak - equity_curves) / running_peak.clamp(min=1)
        max_dd_per_path = drawdowns.max(dim=1).values.cpu().numpy()

        # Kelly analysis per strategy
        kelly_results = self._kelly_analysis(positions)

        # Position sizing recommendations
        sizing = self._position_sizing(positions, bankroll, terminal_np)

        elapsed = time.time() - t0

        return {
            "n_paths": n_paths,
            "horizon_days": horizon_days,
            "bankroll": bankroll,
            "n_positions": n_pos,
            "terminal_equity": {
                "mean": round(float(terminal_np.mean()), 2),
                "median": round(float(np.median(terminal_np)), 2),
                "std": round(float(terminal_np.std()), 2),
                "p5": round(float(np.percentile(terminal_np, 5)), 2),
                "p25": round(float(np.percentile(terminal_np, 25)), 2),
                "p75": round(float(np.percentile(terminal_np, 75)), 2),
                "p95": round(float(np.percentile(terminal_np, 95)), 2),
                "min": round(float(terminal_np.min()), 2),
                "max": round(float(terminal_np.max()), 2),
            },
            "expected_return_pct": round(float((terminal_np.mean() - bankroll) / bankroll * 100), 2),
            "prob_profit": round(float((terminal_np > bankroll).mean()), 4),
            "prob_loss_10pct": round(float((terminal_np < bankroll * 0.9).mean()), 4),
            "prob_loss_20pct": round(float((terminal_np < bankroll * 0.8).mean()), 4),
            **var_results,
            "max_drawdown": {
                "mean": round(float(max_dd_per_path.mean()), 4),
                "median": round(float(np.median(max_dd_per_path)), 4),
                "p95": round(float(np.percentile(max_dd_per_path, 95)), 4),
                "worst": round(float(max_dd_per_path.max()), 4),
            },
            "kelly": kelly_results,
            "sizing_recommendations": sizing,
            "elapsed_s": round(elapsed, 3),
        }

    def _kelly_analysis(self, positions: list[dict]) -> dict:
        """Compute optimal Kelly fraction per strategy group."""
        strats: dict[str, list[dict]] = {}
        for p in positions:
            s = p.get("strategy", "unknown")
            strats.setdefault(s, []).append(p)

        results = {}
        for name, ps in strats.items():
            avg_edge = np.mean([p.get("edgePercent") or 0.02 for p in ps])
            avg_wp = np.mean([p.get("confidence") or 0.55 for p in ps])
            b = avg_edge if avg_edge > 0 else 0.01
            p = avg_wp
            q = 1 - p
            kelly = (b * p - q) / b if b > 0 else 0
            kelly = max(0, kelly)
            results[name] = {
                "full_kelly_pct": round(kelly * 100, 2),
                "half_kelly_pct": round(kelly * 50, 2),
                "quarter_kelly_pct": round(kelly * 25, 2),
                "avg_edge": round(avg_edge, 4),
                "avg_win_prob": round(avg_wp, 4),
                "n_positions": len(ps),
            }
        return results

    def _position_sizing(
        self, positions: list[dict], bankroll: float, terminal_np: np.ndarray
    ) -> list[dict]:
        """Recommend max position sizes per strategy to keep VaR within budget."""
        target_max_loss = bankroll * 0.05  # 5% risk budget
        current_risk = float(np.percentile(terminal_np - bankroll, 5))

        strats: dict[str, float] = {}
        for p in positions:
            s = p.get("strategy", "unknown")
            strats[s] = strats.get(s, 0) + abs(p.get("entryCost") or 100)

        total_invested = sum(strats.values()) or 1
        recs = []
        for name, invested in strats.items():
            share = invested / total_invested
            risk_contrib = current_risk * share
            if abs(risk_contrib) > target_max_loss * share and abs(risk_contrib) > 0:
                scale = abs(target_max_loss * share / risk_contrib)
            else:
                scale = 1.0
            recs.append({
                "strategy": name,
                "current_invested": round(invested, 2),
                "risk_contribution": round(risk_contrib, 2),
                "recommended_scale": round(min(scale, 2.0), 3),
                "recommended_max": round(invested * min(scale, 2.0), 2),
            })

        return sorted(recs, key=lambda x: x["risk_contribution"])

    def stress_test(
        self,
        positions: list[dict],
        bankroll: float = 10000,
        scenarios: list[dict] | None = None,
    ) -> dict:
        """
        Run deterministic stress scenarios.
        Each scenario: {name, win_prob_override (0-1), edge_shock (additive)}
        """
        if scenarios is None:
            scenarios = [
                {"name": "base_case", "win_prob_override": None, "edge_shock": 0},
                {"name": "mild_drawdown", "win_prob_override": 0.35, "edge_shock": -0.01},
                {"name": "severe_drawdown", "win_prob_override": 0.20, "edge_shock": -0.03},
                {"name": "black_swan", "win_prob_override": 0.10, "edge_shock": -0.05},
                {"name": "bull_case", "win_prob_override": 0.70, "edge_shock": 0.01},
            ]

        results = {}
        for sc in scenarios:
            modified = []
            for p in positions:
                mp = {**p}
                if sc.get("win_prob_override") is not None:
                    mp["confidence"] = sc["win_prob_override"]
                if sc.get("edge_shock"):
                    mp["edgePercent"] = max(0, (mp.get("edgePercent") or 0) + sc["edge_shock"])
                modified.append(mp)

            sim = self.simulate_portfolio(modified, bankroll, n_paths=10000, horizon_days=30)
            results[sc["name"]] = {
                "expected_return_pct": sim["expected_return_pct"],
                "prob_profit": sim["prob_profit"],
                "VaR_95": sim.get("VaR_95", 0),
                "max_drawdown_p95": sim["max_drawdown"]["p95"],
                "terminal_median": sim["terminal_equity"]["median"],
            }

        return {"scenarios": results, "n_positions": len(positions)}

    def _empty_result(self, bankroll: float) -> dict:
        return {
            "n_paths": 0,
            "bankroll": bankroll,
            "n_positions": 0,
            "terminal_equity": {"mean": bankroll},
            "expected_return_pct": 0,
            "prob_profit": 0.5,
            "message": "No positions to simulate",
        }

    def get_status(self) -> dict:
        vram = 0
        if self.device == "cuda":
            vram = torch.cuda.memory_allocated() / 1e9
        return {
            "device": self.device,
            "max_paths": MC_MAX_PATHS,
            "default_paths": MC_DEFAULT_PATHS,
            "vram_gb": round(vram, 2),
        }
