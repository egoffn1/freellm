import os
import json
import base64
import logging
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from pathlib import Path

from config import WORKSPACE_DIR, GMAIL_CREDENTIALS_FILE, GMAIL_TOKEN_FILE, GMAIL_TOKEN_JSON

logger = logging.getLogger(__name__)

SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]

try:
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
    HAS_GOOGLE = True
except ImportError:
    HAS_GOOGLE = False
    Credentials = None
    build = None
    HttpError = Exception


def _get_creds_path() -> Path:
    if GMAIL_CREDENTIALS_FILE:
        return Path(GMAIL_CREDENTIALS_FILE)
    return Path(WORKSPACE_DIR) / ".gmail_credentials.json"


def _get_token_path() -> Path:
    if GMAIL_TOKEN_FILE:
        return Path(GMAIL_TOKEN_FILE)
    return Path(WORKSPACE_DIR) / ".gmail_token.json"


def _authenticate() -> Credentials | None:
    if not HAS_GOOGLE:
        logger.error("google-api-python-client not installed")
        return None

    creds = None
    token_path = _get_token_path()

    # 1. Try env var token JSON
    if GMAIL_TOKEN_JSON:
        try:
            creds = Credentials.from_authorized_user_info(json.loads(GMAIL_TOKEN_JSON), SCOPES)
        except Exception as e:
            logger.warning(f"Failed to load token from GMAIL_TOKEN_JSON: {e}")

    # 2. Try token file
    if not creds and token_path.exists():
        try:
            creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
        except Exception as e:
            logger.warning(f"Failed to load token file: {e}")

    # 3. Refresh if expired
    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            token_path.parent.mkdir(parents=True, exist_ok=True)
            token_path.write_text(creds.to_json())
            return creds
        except Exception as e:
            logger.warning(f"Token refresh failed: {e}")
            creds = None

    if creds and creds.valid:
        return creds

    # 4. First-time auth flow
    creds_path = _get_creds_path()
    if not creds_path.exists():
        logger.error(
            f"No Gmail credentials file at {creds_path}. "
            f"Create a Google Cloud project, enable Gmail API, "
            f"download OAuth desktop credentials and place at {creds_path}, "
            f"or set GMAIL_TOKEN_JSON env var with the token"
        )
        return None

    try:
        flow = InstalledAppFlow.from_client_secrets_file(str(creds_path), SCOPES)
        creds = flow.run_local_server(port=0)
        token_path.parent.mkdir(parents=True, exist_ok=True)
        token_path.write_text(creds.to_json())
        logger.info(f"Gmail token saved to {token_path}")
        return creds
    except Exception as e:
        logger.error(f"Gmail auth failed: {e}")
        return None


def _get_service():
    creds = _authenticate()
    if not creds:
        return None
    return build("gmail", "v1", credentials=creds)


def _decode_body(payload) -> str:
    if "parts" in payload:
        parts = payload["parts"]
        text = ""
        for part in parts:
            if part.get("mimeType") == "text/plain":
                data = part.get("body", {}).get("data", "")
                if data:
                    text += base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
            elif "parts" in part:
                text += _decode_body(part)
        return text
    data = payload.get("body", {}).get("data", "")
    if data:
        return base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
    return ""


def _format_message(msg) -> dict:
    headers = {h["name"].lower(): h["value"] for h in msg.get("payload", {}).get("headers", [])}
    body = _decode_body(msg.get("payload", {}))
    return {
        "id": msg["id"],
        "threadId": msg.get("threadId", ""),
        "from": headers.get("from", ""),
        "to": headers.get("to", ""),
        "subject": headers.get("subject", "(без темы)"),
        "date": headers.get("date", ""),
        "snippet": msg.get("snippet", ""),
        "body": body[:5000] if body else "",
    }


async def gmail_list(max_results: int = 10, query: str = "") -> str:
    service = _get_service()
    if not service:
        return "❌ Gmail не подключён. Проверь логи — нужна авторизация."

    try:
        results = service.users().messages().list(
            userId="me", maxResults=min(max_results, 50), q=query
        ).execute()
        messages = results.get("messages", [])
        if not messages:
            return "📭 Входящие пусты."

        lines = [f"📬 Найдено писем: {len(messages)}"]
        for m in messages[:max_results]:
            msg = service.users().messages().get(
                userId="me", id=m["id"], format="metadata",
                metadataHeaders=["From", "Subject", "Date"],
            ).execute()
            headers = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}
            lines.append(
                f"• {headers.get('Date', '?')} — {headers.get('From', '?')}\n"
                f"  Тема: {headers.get('Subject', '(без темы)')}\n"
                f"  ID: {m['id']}"
            )

        return "\n\n".join(lines)
    except HttpError as e:
        return f"❌ Ошибка Gmail API: {e}"


async def gmail_read(message_id: str) -> str:
    service = _get_service()
    if not service:
        return "❌ Gmail не подключён."

    try:
        msg = service.users().messages().get(
            userId="me", id=message_id, format="full"
        ).execute()
        data = _format_message(msg)
        if not data["body"]:
            data["body"] = data["snippet"]

        return (
            f"📧 **{data['subject']}**\n"
            f"От: {data['from']}\n"
            f"Кому: {data['to']}\n"
            f"Дата: {data['date']}\n\n"
            f"{data['body']}"
        )
    except HttpError as e:
        return f"❌ Ошибка: {e}"


async def gmail_send(to: str, subject: str, body: str) -> str:
    service = _get_service()
    if not service:
        return "❌ Gmail не подключён."

    try:
        msg = MIMEMultipart("alternative")
        msg["To"] = to
        msg["Subject"] = subject
        msg.attach(MIMEText(body, "plain", "utf-8"))
        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()

        service.users().messages().send(userId="me", body={"raw": raw}).execute()
        return f"✅ Письмо отправлено на {to}"
    except HttpError as e:
        return f"❌ Ошибка отправки: {e}"


async def gmail_search(query: str, max_results: int = 10) -> str:
    return await gmail_list(max_results=max_results, query=query)


async def gmail_unread_count() -> str:
    service = _get_service()
    if not service:
        return "❌ Gmail не подключён."

    try:
        profile = service.users().getProfile(userId="me").execute()
        labels = service.users().labels().get(userId="me", id="INBOX").execute()
        unread = labels.get("messagesUnread", 0)
        total = labels.get("messagesTotal", 0)
        email = profile.get("emailAddress", "?")
        return f"📬 **{email}**\nНепрочитано: {unread}\nВсего: {total}"
    except HttpError as e:
        return f"❌ Ошибка: {e}"
