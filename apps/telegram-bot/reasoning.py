import re
from config import FREELLM_BASE_URL, FREELLM_API_KEY

COT_SYSTEM_PROMPT = """You are a reasoning engine. Your ONLY job is to think step-by-step.
Given a user request, you must:

1. **Analyze**: Break down the request into core components. What does the user want?
2. **Plan**: List 3-5 concrete steps needed to accomplish it. For each step say which tool(s) are needed.
3. **Anticipate**: What could go wrong? What edge cases exist? How will you handle them?
4. **Output**: Return ONLY a JSON object with these keys:
   - `analysis`: short summary of what's needed
   - `steps`: array of {step, tool, description} objects
   - `risks`: array of potential issues
   - `success_criteria`: how to know the task is done

Example output:
{
  "analysis": "User wants a Python web server file",
  "steps": [
    {"step": 1, "tool": "write", "description": "Create main.py with FastAPI app"}
  ],
  "risks": ["Requirements.txt not included"],
  "success_criteria": "File created and validated"
}
"""

REFLECTION_PROMPT = """You are a critical reviewer. Review the completed work:
- Does the result fully satisfy the original request?
- Are there any bugs, errors, or edge cases not handled?
- Is the code idiomatic and well-structured?
- What improvements would you suggest?

Return a JSON: {"score": 1-10, "issues": [...], "suggestions": [...]}"""


def build_cot_prompt(user_request: str, context: str = "") -> list[dict]:
    msgs = [{"role": "system", "content": COT_SYSTEM_PROMPT}]
    if context:
        msgs.append({"role": "user", "content": f"Context:\n{context}\n\nRequest: {user_request}"})
    else:
        msgs.append({"role": "user", "content": user_request})
    return msgs


def build_reflection_prompt(task: str, result: str) -> list[dict]:
    return [
        {"role": "system", "content": REFLECTION_PROMPT},
        {"role": "user", "content": f"Task: {task}\n\nResult:\n{result}"},
    ]


def parse_json_response(text: str) -> dict | None:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\n?|```$", "", text, flags=re.MULTILINE).strip()
    try:
        import json
        return json.loads(text)
    except json.JSONDecodeError:
        return None
