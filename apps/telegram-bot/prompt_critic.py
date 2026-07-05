import json
import logging
from openai import OpenAI
from config import FREELLM_BASE_URL, FREELLM_API_KEY, AGENT_MODEL

logger = logging.getLogger(__name__)
_client = OpenAI(base_url=FREELLM_BASE_URL, api_key=FREELLM_API_KEY)

CRITIC_SYSTEM_PROMPT = """You are a Prompt Improvement Critic. Your job:
1. Analyze a conversation between a user and an AI assistant where something went wrong.
2. Identify the ROOT CAUSE of the mistake.
3. Write a NEW RULE in plain text that would prevent this mistake in the future.
4. The rule must be:
   - Specific and actionable ("Always do X when Y happens")
   - In Russian
   - Max 5 sentences
   - Start with "# Rule: " followed by a short title

Output ONLY valid JSON:
{"analysis": "brief analysis in Russian", "rule": "# Rule: Title\\n\\nRule text here...", "category": "learned"}

If the mistake was not the AI's fault (e.g. external API error, user error), output:
{"analysis": "Not an AI mistake.", "rule": null, "category": null}"""


def analyze_error(user_message: str, ai_response: str, error_info: str) -> dict | None:
    try:
        resp = _client.chat.completions.create(
            model=AGENT_MODEL,
            messages=[
                {"role": "system", "content": CRITIC_SYSTEM_PROMPT},
                {"role": "user", "content":
                    f"## User message\n{user_message}\n\n"
                    f"## AI response\n{ai_response}\n\n"
                    f"## Error / Problem\n{error_info}"},
            ],
            timeout=30,
        )
        text = resp.choices[0].message.content.strip()
        text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        return json.loads(text)
    except Exception as e:
        logger.warning(f"Critic analysis failed: {e}")
        return None
