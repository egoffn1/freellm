import asyncio
import re
from openai import OpenAI
from config import (
    FREELLM_BASE_URL, FREELLM_API_KEY, COMPLEXITY_THRESHOLD,
    ORCHESTRATOR_MODELS, AGGREGATOR_MODEL, SIMPLE_MODEL,
)


_client = OpenAI(base_url=FREELLM_BASE_URL, api_key=FREELLM_API_KEY)


def _is_complex(text: str) -> bool:
    if len(text) > COMPLEXITY_THRESHOLD:
        return True
    code_patterns = [
        r"```", r"def |class |function ", r"import |from ", r"#include",
        r"public static void", r"fn |impl ", r"package ",
    ]
    if any(re.search(p, text) for p in code_patterns):
        return True
    keywords = [
        "architecture", "design pattern", "архитектур", "паттерн",
        "алгоритм", "оптимизаци", "сравни", "complex",
        "рефакторинг", "интеграци", "deploy", "microservice",
    ]
    if any(kw in text.lower() for kw in keywords):
        return True
    return False


def _call_model(model: str, messages: list) -> str | None:
    try:
        resp = _client.chat.completions.create(
            model=model, messages=messages, timeout=60,
        )
        return resp.choices[0].message.content
    except Exception:
        return None


async def _call_model_async(model: str, messages: list) -> tuple[str, str | None]:
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, _call_model, model, messages)
    return model, result


async def simple_answer(messages: list) -> str | None:
    return await asyncio.get_event_loop().run_in_executor(
        None, _call_model, SIMPLE_MODEL, messages,
    )


async def orchestrate(messages: list) -> str:
    tasks = [_call_model_async(m, messages) for m in ORCHESTRATOR_MODELS]
    results = await asyncio.gather(*tasks)

    valid = [(model, resp) for model, resp in results if resp is not None]
    if not valid:
        return "⚠️ Все модели недоступны. Попробуйте позже."

    if len(valid) == 1:
        return valid[0][1]

    parts = []
    for model, resp in valid:
        parts.append(f"--- Ответ от {model} ---\n{resp}")

    combined = "\n\n".join(parts)

    agg_messages = [
        {
            "role": "system",
            "content": (
                "Ты — агрегатор ответов от нескольких AI моделей. "
                "У тебя есть несколько ответов на один и тот же вопрос. "
                "Выбери лучший или объедини их в один качественный, полный, "
                "структурированный ответ. Убери противоречия. "
                "Верни только финальный ответ без лишних пояснений."
            ),
        },
        {"role": "user", "content": f"Вопрос пользователя:\n{messages[-1]['content']}"},
        {"role": "user", "content": f"Ответы от моделей:\n\n{combined}"},
    ]

    best = _call_model(AGGREGATOR_MODEL, agg_messages)
    return best or valid[0][1]


def is_complex(text: str) -> bool:
    return _is_complex(text)
