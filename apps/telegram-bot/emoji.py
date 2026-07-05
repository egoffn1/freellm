import html
import re

PREMIUM = {
    "🤖": '<tg-emoji emoji-id="5372981976804366741">🤖</tg-emoji>',
    "🧹": '<tg-emoji emoji-id="5294021605817608143">🧹</tg-emoji>',
    "📥": '<tg-emoji emoji-id="5433811242135331842">📥</tg-emoji>',
    "📤": '<tg-emoji emoji-id="5433614747381538714">📤</tg-emoji>',
    "📦": '<tg-emoji emoji-id="5472335930549347896">📦</tg-emoji>',
    "✍️": '<tg-emoji emoji-id="5197269100878907942">✍️</tg-emoji>',
    "👁": '<tg-emoji emoji-id="5424892643760937442">👁</tg-emoji>',
    "🔍": '<tg-emoji emoji-id="5188217332748527444">🔍</tg-emoji>',
    "🗑": '<tg-emoji emoji-id="5445267414562389170">🗑</tg-emoji>',
    "🤔": '<tg-emoji emoji-id="5370724846936267183">🤔</tg-emoji>',
    "✅": '<tg-emoji emoji-id="5267120447526301429">✅</tg-emoji>',
    "❌": '<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji>',
    "🛠": '<tg-emoji emoji-id="5462921117423384478">🛠</tg-emoji>',
    "🔄": '<tg-emoji emoji-id="5264727218734524899">🔄</tg-emoji>',
    "📁": '<tg-emoji emoji-id="5433653135799228968">📁</tg-emoji>',
    "⚠️": '<tg-emoji emoji-id="5447644880824181073">⚠️</tg-emoji>',
    "⚠": '<tg-emoji emoji-id="5447644880824181073">⚠️</tg-emoji>',
    "🧠": '<tg-emoji emoji-id="5237799019329105246">🧠</tg-emoji>',
    "👨‍💻": '<tg-emoji emoji-id="5388956106934466908">👨‍💻</tg-emoji>',
    "🔎": '<tg-emoji emoji-id="5188311512791393083">🔎</tg-emoji>',
    "📀": '<tg-emoji emoji-id="5462956611033117422">📀</tg-emoji>',
    "🛡": '<tg-emoji emoji-id="5251203410396458957">🛡</tg-emoji>',
    "🔒": '<tg-emoji emoji-id="5296369303661067030">🔒</tg-emoji>',
    "📋": '<tg-emoji emoji-id="5197269100878907942">📋</tg-emoji>',
    "🌐": '<tg-emoji emoji-id="5447410659077661506">🌐</tg-emoji>',
    "🛑": '<tg-emoji emoji-id="6084515769780013003">🛑</tg-emoji>',
    "📊": '<tg-emoji emoji-id="5431577498364158238">📊</tg-emoji>',
    "💬": '<tg-emoji emoji-id="5443038326535759644">💬</tg-emoji>',
}


def premium(text: str) -> str:
    for char, tag in PREMIUM.items():
        text = text.replace(char, tag)
    return text


def md_to_html(text: str) -> str:
    text = premium(text)
    placeholders = {}
    def _save(m):
        key = f"\x00P{len(placeholders)}\x00"
        placeholders[key] = m.group(0)
        return key
    text = re.sub(r"<tg-emoji[^>]*>.*?</tg-emoji>", _save, text)
    text = html.escape(text, quote=False)
    for key, val in placeholders.items():
        text = text.replace(key, val)
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"(?<![*])\*(.+?)\*(?![*])", r"<i>\1</i>", text)
    text = re.sub(r"`(.+?)`", r"<code>\1</code>", text)
    text = re.sub(r"^### (.+)$", r"<b>\1</b>", text, flags=re.MULTILINE)
    text = re.sub(r"^## (.+)$", r"<b>\1</b>", text, flags=re.MULTILINE)
    text = re.sub(r"^# (.+)$", r"<b>\1</b>", text, flags=re.MULTILINE)
    return text
