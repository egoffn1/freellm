import logging
import re

logger = logging.getLogger(__name__)

BLOCKED_PATTERNS = re.compile(
    r"(ignore\s+(all\s+)?(previous|above|prior)\s+instructions|"
    r"forget\s+(everything|all)\s+(you\s+knew|previous)|"
    r"you\s+are\s+now\s+(a\s+)?(free|unrestricted| DAN|jailbroken)|"
    r"jailbreak|prompt\s+injection|leak\s+(the\s+)?prompt|"
    r"output\s+your\s+(system\s+)?prompt|"
    r"reveal\s+(the\s+)?(system\s+)?instructions|"
    r"act\s+as\s+(DAN|STAN|GPT-?\d*\s*Unrestricted)|"
    r"do\s+anything\s+now|no\s+(restrictions|limits|boundaries|filter)|"
    r"bypass\s+(the\s+)?(filter|restrictions|safety)|"
    r"your\s+initial\s+prompt|first\s+message\s+from\s+system)",
    re.IGNORECASE,
)

SENSITIVE_PATTERNS = re.compile(
    r"(-----BEGIN\s+(RSA|DSA|EC|PGP|OPENSSH)\s+PRIVATE\s+KEY-----|"
    r"sk-[a-zA-Z0-9]{20,}|"
    r"ghp_[a-zA-Z0-9]{36}|"
    r"gho_[a-zA-Z0-9]{36}|"
    r"ghu_[a-zA-Z0-9]{36}|"
    r"AKIA[0-9A-Z]{16}|"
    r"api[-_]?key[\s\"'=:]+[a-zA-Z0-9_\-]{16,}|"
    r"password[\s\"'=:]+[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{}|;:',.<>?/~]{8,}|"
    r"token[\s\"'=:]+[a-zA-Z0-9_\-]{10,})",
    re.IGNORECASE,
)

CRITICAL_COMMANDS = re.compile(
    r"\b(rm\s+-rf\s+[/~]|sudo\s+rm\s+-rf|dd\s+if=|mkfs\.|"
    r"chmod\s+-R\s+777\s+/|wget\s+.+?\|.*?sh|curl\s+.+?\|.*?bash|"
    r":\s*\(\)\s*\{|fork\s*bomb|>\/dev\/sda)",
    re.IGNORECASE,
)


def check_input(text: str) -> dict:
    issues = []
    if BLOCKED_PATTERNS.search(text):
        issues.append("prompt_injection")
    if CRITICAL_COMMANDS.search(text):
        issues.append("dangerous_command")
    if SENSITIVE_PATTERNS.search(text):
        issues.append("sensitive_data")
    warnings = []
    if "prompt_injection" in issues:
        warnings.append("⚠️ Обнаружена попытка инъекции в промпт. Запрос отклонён.")
    if "dangerous_command" in issues:
        warnings.append("⚠️ Обнаружена опасная команда. Блокировано.")
    if "sensitive_data" in issues:
        warnings.append("⚠️ Обнаружены потенциальные чувствительные данные. Будьте осторожны.")
    return {"blocked": bool(warnings), "warnings": warnings, "issues": issues}


def check_output(text: str) -> dict:
    issues = []
    if SENSITIVE_PATTERNS.search(text):
        issues.append("sensitive_leak")
    issues_list = []
    if "sensitive_leak" in issues:
        issues_list.append("⚠️ Ответ содержит потенциальные чувствительные данные. Они будут скрыты.")
    return {"blocked": bool(issues_list), "warnings": issues_list, "issues": issues}


def sanitize_output(text: str) -> str:
    text = SENSITIVE_PATTERNS.sub("[REDACTED]", text)
    return text
