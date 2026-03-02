"""
Two-Tier Sentiment Engine

Tier 1 — Fast (RoBERTa, ~20ms):
  twitter-roberta-base-sentiment for quick tweet/headline classification.
  Returns sentiment label + score.

Tier 2 — Deep (Mistral 7B 4-bit, ~2s):
  Quantized LLM that reads a news snippet + market question and produces
  a structured JSON assessment: directional bias, confidence, reasoning.
  Results are cached (LRU) to avoid redundant inference.

Both tiers run on CUDA when available. The server exposes /predict/sentiment
which automatically chooses the tier based on the request's `depth` field.
"""

import os, json, hashlib, time
from functools import lru_cache
from collections import OrderedDict
import torch
import numpy as np

from config import (
    DEVICE, FAST_SENTIMENT_MODEL, DEEP_SENTIMENT_MODEL,
    SENTIMENT_CACHE_SIZE, DEEP_SENTIMENT_MAX_TOKENS,
)


class LRUCache:
    def __init__(self, capacity: int):
        self._cache: OrderedDict[str, tuple[dict, float]] = OrderedDict()
        self._cap = capacity

    def get(self, key: str, max_age: float = 3600) -> dict | None:
        if key in self._cache:
            val, ts = self._cache[key]
            if time.time() - ts < max_age:
                self._cache.move_to_end(key)
                return val
            del self._cache[key]
        return None

    def put(self, key: str, val: dict):
        self._cache[key] = (val, time.time())
        if len(self._cache) > self._cap:
            self._cache.popitem(last=False)


class SentimentEngine:
    def __init__(self):
        self._fast_pipeline = None
        self._deep_model = None
        self._deep_tokenizer = None
        self._cache = LRUCache(SENTIMENT_CACHE_SIZE)
        self._fast_ready = False
        self._deep_ready = False

    def load_fast(self):
        if self._fast_ready:
            return
        from transformers import pipeline
        self._fast_pipeline = pipeline(
            "sentiment-analysis",
            model=FAST_SENTIMENT_MODEL,
            device=0 if DEVICE == "cuda" else -1,
            truncation=True,
            max_length=512,
        )
        self._fast_ready = True
        print(f"[Sentiment] Fast model loaded: {FAST_SENTIMENT_MODEL}")

    def load_deep(self):
        if self._deep_ready:
            return
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

        bnb_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.float16,
            bnb_4bit_use_double_quant=True,
        )
        self._deep_tokenizer = AutoTokenizer.from_pretrained(
            DEEP_SENTIMENT_MODEL, trust_remote_code=True,
        )
        self._deep_model = AutoModelForCausalLM.from_pretrained(
            DEEP_SENTIMENT_MODEL,
            quantization_config=bnb_config,
            device_map="auto",
            trust_remote_code=True,
        )
        self._deep_ready = True
        print(f"[Sentiment] Deep model loaded: {DEEP_SENTIMENT_MODEL} (4-bit)")

    def _cache_key(self, text: str, market: str, depth: str) -> str:
        raw = f"{depth}:{market}:{text}"
        return hashlib.sha256(raw.encode()).hexdigest()[:32]

    def analyze_fast(self, texts: list[str]) -> list[dict]:
        """Batch-classify headlines/tweets. Returns list of {label, score, sentiment_value}."""
        if not self._fast_ready:
            self.load_fast()
        results = self._fast_pipeline(texts, batch_size=min(len(texts), 32))
        out = []
        for r in results:
            label = r["label"].lower()
            score = r["score"]
            val = score if "positive" in label else (-score if "negative" in label else 0)
            out.append({"label": label, "score": round(score, 4), "sentiment_value": round(val, 4)})
        return out

    @torch.no_grad()
    def analyze_deep(self, text: str, market_question: str) -> dict:
        """
        Use the LLM to produce a structured directional assessment.
        Returns {direction, confidence, reasoning, sentiment_value}.
        """
        cache_key = self._cache_key(text, market_question, "deep")
        cached = self._cache.get(cache_key)
        if cached:
            return {**cached, "cached": True}

        if not self._deep_ready:
            self.load_deep()

        prompt = (
            f"You are a prediction-market analyst. Given a news snippet and a market question, "
            f"produce a JSON object with exactly these keys:\n"
            f'  "direction": "BUY_YES" or "BUY_NO" or "HOLD",\n'
            f'  "confidence": float 0-1,\n'
            f'  "reasoning": string (one sentence)\n\n'
            f"News: {text[:800]}\n"
            f"Market: {market_question[:300]}\n\n"
            f"Respond with ONLY valid JSON, no markdown.\n"
        )

        messages = [{"role": "user", "content": prompt}]

        if hasattr(self._deep_tokenizer, "apply_chat_template"):
            input_ids = self._deep_tokenizer.apply_chat_template(
                messages, return_tensors="pt", add_generation_prompt=True
            ).to(self._deep_model.device)
        else:
            input_ids = self._deep_tokenizer(prompt, return_tensors="pt").input_ids.to(
                self._deep_model.device
            )

        output = self._deep_model.generate(
            input_ids,
            max_new_tokens=DEEP_SENTIMENT_MAX_TOKENS,
            temperature=0.1,
            do_sample=True,
            top_p=0.9,
            pad_token_id=self._deep_tokenizer.eos_token_id,
        )

        generated = self._deep_tokenizer.decode(
            output[0][input_ids.shape[1]:], skip_special_tokens=True
        ).strip()

        result = self._parse_llm_output(generated)
        self._cache.put(cache_key, result)
        return result

    def _parse_llm_output(self, raw: str) -> dict:
        """Best-effort JSON parse from LLM output."""
        try:
            start = raw.find("{")
            end = raw.rfind("}") + 1
            if start >= 0 and end > start:
                obj = json.loads(raw[start:end])
                direction = obj.get("direction", "HOLD")
                conf = float(obj.get("confidence", 0.5))
                reasoning = str(obj.get("reasoning", ""))
                sv = conf if direction == "BUY_YES" else (-conf if direction == "BUY_NO" else 0)
                return {
                    "direction": direction,
                    "confidence": round(min(max(conf, 0), 1), 3),
                    "reasoning": reasoning[:300],
                    "sentiment_value": round(sv, 4),
                }
        except Exception:
            pass
        return {"direction": "HOLD", "confidence": 0.5, "reasoning": "parse_error", "sentiment_value": 0}

    def analyze_batch(self, items: list[dict]) -> list[dict]:
        """
        Process a batch of {text, market_question, depth} items.
        Routes to fast or deep based on depth field.
        """
        fast_items = [i for i in items if i.get("depth", "fast") == "fast"]
        deep_items = [i for i in items if i.get("depth") == "deep"]

        results = {}

        if fast_items:
            texts = [i["text"] for i in fast_items]
            fast_results = self.analyze_fast(texts)
            for item, res in zip(fast_items, fast_results):
                idx = items.index(item)
                results[idx] = {**res, "depth": "fast", "market": item.get("market_question", "")}

        for item in deep_items:
            idx = items.index(item)
            res = self.analyze_deep(item["text"], item.get("market_question", ""))
            results[idx] = {**res, "depth": "deep", "market": item.get("market_question", "")}

        return [results.get(i, {"error": "not_processed"}) for i in range(len(items))]

    def get_status(self) -> dict:
        vram = 0
        if DEVICE == "cuda":
            vram = torch.cuda.memory_allocated() / 1e9
        return {
            "fast_model": FAST_SENTIMENT_MODEL if self._fast_ready else "not_loaded",
            "deep_model": DEEP_SENTIMENT_MODEL if self._deep_ready else "not_loaded",
            "cache_size": len(self._cache._cache),
            "device": DEVICE,
            "vram_gb": round(vram, 2),
        }
