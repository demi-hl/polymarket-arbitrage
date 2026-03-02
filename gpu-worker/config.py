import os, torch

HOST = os.getenv("GPU_WORKER_HOST", "0.0.0.0")
PORT = int(os.getenv("GPU_WORKER_PORT", "8899"))

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32

MODEL_DIR = os.path.join(os.path.dirname(__file__), "data")

# Edge Predictor
EDGE_MODEL_PATH = os.path.join(MODEL_DIR, "edge_predictor.pt")
EDGE_HIDDEN_DIM = 128
EDGE_N_STRATEGIES = 25
EDGE_N_CATEGORIES = 100
EDGE_EMBED_DIM = 8
EDGE_LR = 1e-3

# Sentiment
FAST_SENTIMENT_MODEL = "cardiffnlp/twitter-roberta-base-sentiment-latest"
DEEP_SENTIMENT_MODEL = os.getenv(
    "DEEP_LLM_MODEL", "mistralai/Mistral-7B-Instruct-v0.3"
)
SENTIMENT_CACHE_SIZE = 2048
DEEP_SENTIMENT_MAX_TOKENS = 256

# Orderbook CNN
ORDERBOOK_MODEL_PATH = os.path.join(MODEL_DIR, "orderbook_cnn.pt")
ORDERBOOK_LEVELS = 10
ORDERBOOK_FEATURES = 4  # price, size, cumulative, concentration

# Backtester
BACKTEST_DEFAULT_PATHS = 10_000
BACKTEST_MAX_PATHS = 100_000

# Monte Carlo
MC_DEFAULT_PATHS = 50_000
MC_MAX_PATHS = 500_000
MC_CONFIDENCE_LEVELS = [0.95, 0.99]
