import json
import logging
from pathlib import Path

from config import WORKSPACE_DIR, FIREBASE_SERVICE_ACCOUNT_JSON

logger = logging.getLogger(__name__)

try:
    import firebase_admin
    from firebase_admin import credentials, firestore
    from google.cloud.firestore import SERVER_TIMESTAMP
    HAS_FIREBASE = True
except ImportError:
    HAS_FIREBASE = False
    firebase_admin = None
    credentials = None
    firestore = None
    SERVER_TIMESTAMP = None

_app = None
_db = None


def init_firebase():
    global _app, _db
    if _app is not None:
        return True

    if not HAS_FIREBASE:
        logger.warning("firebase-admin not installed")
        return False

    if not FIREBASE_SERVICE_ACCOUNT_JSON:
        logger.info("FIREBASE_SERVICE_ACCOUNT_JSON not set — Firebase disabled")
        return False

    try:
        cred_data = json.loads(FIREBASE_SERVICE_ACCOUNT_JSON)
        cred = credentials.Certificate(cred_data)
        _app = firebase_admin.initialize_app(cred)
        _db = firestore.client()
        logger.info("Firebase initialized")
        return True
    except Exception as e:
        logger.error(f"Firebase init failed: {e}")
        _app = None
        _db = None
        return False


def db():
    if _db is None:
        init_firebase()
    return _db


# ─── Gmail tokens ─────────────────────────────────────────

def get_gmail_token(uid: int) -> str | None:
    client = db()
    if client is None:
        return None

    try:
        doc = client.collection("gmail_tokens").document(str(uid)).get()
        if doc.exists:
            data = doc.to_dict()
            token_json = data.get("token_json")
            if token_json:
                return token_json
        return None
    except Exception as e:
        logger.warning(f"Firebase get_gmail_token error: {e}")
        return None


def save_gmail_token(uid: int, token_json: str):
    client = db()
    if client is None:
        return

    try:
        client.collection("gmail_tokens").document(str(uid)).set({
            "token_json": token_json,
            "updated_at": SERVER_TIMESTAMP,
        })
        logger.info(f"Gmail token saved to Firebase for user {uid}")
    except Exception as e:
        logger.warning(f"Firebase save_gmail_token error: {e}")


# ─── Conversation history ─────────────────────────────────

def get_history(uid: int) -> list | None:
    client = db()
    if client is None:
        return None

    try:
        doc = client.collection("histories").document(str(uid)).get()
        if doc.exists:
            data = doc.to_dict()
            return data.get("messages", [])
        return None
    except Exception as e:
        logger.warning(f"Firebase get_history error: {e}")
        return None


def save_history(uid: int, messages: list):
    client = db()
    if client is None:
        return

    try:
        client.collection("histories").document(str(uid)).set({
            "messages": messages[-100:],
            "updated_at": SERVER_TIMESTAMP,
        })
    except Exception as e:
        logger.warning(f"Firebase save_history error: {e}")


# ─── User settings ───────────────────────────────────────

DEFAULT_USER_SETTINGS = {
    "language": "ru",
    "model": "",
    "notifications": True,
}

def get_user_settings(uid: int) -> dict:
    client = db()
    if client is None:
        return dict(DEFAULT_USER_SETTINGS)

    try:
        doc = client.collection("users").document(str(uid)).get()
        if doc.exists:
            data = doc.to_dict()
            out = dict(DEFAULT_USER_SETTINGS)
            out.update({k: v for k, v in data.items() if k in DEFAULT_USER_SETTINGS})
            return out
        return dict(DEFAULT_USER_SETTINGS)
    except Exception as e:
        logger.warning(f"Firebase get_user_settings error: {e}")
        return dict(DEFAULT_USER_SETTINGS)


def save_user_settings(uid: int, settings: dict):
    client = db()
    if client is None:
        return

    clean = {k: v for k, v in settings.items() if k in DEFAULT_USER_SETTINGS}
    clean["updated_at"] = SERVER_TIMESTAMP
    try:
        client.collection("users").document(str(uid)).set(clean, merge=True)
        logger.info(f"Settings saved for user {uid}")
    except Exception as e:
        logger.warning(f"Firebase save_user_settings error: {e}")


# ─── Integrations ─────────────────────────────────────────

def get_integration(uid: int, service: str) -> dict | None:
    client = db()
    if client is None:
        return None

    try:
        doc = client.collection("integrations").document(str(uid)).collection("services").document(service).get()
        if doc.exists:
            return doc.to_dict()
        return None
    except Exception as e:
        logger.warning(f"Firebase get_integration error: {e}")
        return None


def save_integration(uid: int, service: str, data: dict):
    client = db()
    if client is None:
        return

    data["updated_at"] = SERVER_TIMESTAMP
    try:
        client.collection("integrations").document(str(uid)).collection("services").document(service).set(data, merge=True)
    except Exception as e:
        logger.warning(f"Firebase save_integration error: {e}")


def list_integrations(uid: int) -> list[str]:
    client = db()
    if client is None:
        return []

    try:
        docs = client.collection("integrations").document(str(uid)).collection("services").list_documents()
        services = []
        for doc in docs:
            snap = doc.get()
            if snap.exists:
                data = snap.to_dict()
                if data.get("enabled"):
                    services.append(doc.id)
        return services
    except Exception as e:
        logger.warning(f"Firebase list_integrations error: {e}")
        return []
