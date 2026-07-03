import os


TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
FREELLM_BASE_URL = os.getenv("FREELLM_BASE_URL", "http://localhost:3000/v1")
FREELLM_API_KEY = os.getenv("FREELLM_API_KEY", "unused")

COMPLEXITY_THRESHOLD = int(os.getenv("COMPLEXITY_THRESHOLD", "150"))
ORCHESTRATOR_MODELS = os.getenv(
    "ORCHESTRATOR_MODELS",
    "free-smart,github/meta/Meta-Llama-3.3-70B-Instruct,groq/llama-3.3-70b-versatile",
).split(",")

AGGREGATOR_MODEL = os.getenv("AGGREGATOR_MODEL", "free-smart")
SIMPLE_MODEL = os.getenv("SIMPLE_MODEL", "free-fast")
MAX_HISTORY = int(os.getenv("MAX_HISTORY", "20"))
