from __future__ import annotations

import json
import sys
from typing import Any

try:
  from run_picker_automation import RESULT_TABLE, now_china, supabase
except ModuleNotFoundError:
  from scripts.run_picker_automation import RESULT_TABLE, now_china, supabase


def read_payload() -> dict[str, Any]:
  path = sys.argv[1] if len(sys.argv) > 1 else "-"
  if path == "-":
    text = sys.stdin.read()
  else:
    with open(path, "r", encoding="utf-8") as file:
      text = file.read()
  payload = json.loads(text)
  if isinstance(payload, dict) and isinstance(payload.get("result"), dict):
    payload = payload["result"]
  if not isinstance(payload, dict):
    raise ValueError("result payload must be a JSON object")
  return payload


def text(value: Any) -> str:
  return str(value or "").strip()


def text_list(value: Any) -> list[str]:
  if isinstance(value, list):
    return [text(item) for item in value if text(item)]
  if isinstance(value, str) and value.strip():
    return [value.strip()]
  return []


def optional_code(value: Any) -> str | None:
  clean = "".join(char for char in str(value or "") if char.isdigit())[:6]
  return clean if len(clean) == 6 else None


def boolean(value: Any, fallback: bool = True) -> bool:
  if value is None:
    return fallback
  if isinstance(value, bool):
    return value
  if isinstance(value, str):
    return value.strip().lower() not in {"0", "false", "no", "off"}
  return bool(value)


def integer(value: Any, fallback: int = 0) -> int:
  try:
    return int(value)
  except (TypeError, ValueError):
    return fallback


def normalize(payload: dict[str, Any]) -> dict[str, Any]:
  candidate = payload.get("candidate") if isinstance(payload.get("candidate"), dict) else {}
  title = text(payload.get("title"))
  summary = text(payload.get("summary"))
  rationale = text_list(payload.get("rationale"))
  risks = text_list(payload.get("risks"))
  action = text(payload.get("action"))
  if not title:
    raise ValueError("title is required")
  if not summary:
    raise ValueError("summary is required")
  if not rationale:
    raise ValueError("rationale must contain at least one item")
  if not risks:
    raise ValueError("risks must contain at least one item")
  if not action:
    raise ValueError("action is required")

  return {
    "trade_date": text(payload.get("trade_date")) or now_china().date().isoformat(),
    "generated_at": text(payload.get("generated_at")) or now_china().isoformat(),
    "title": title,
    "summary": summary,
    "rationale": rationale,
    "risks": risks,
    "action": action,
    "prompt": text(payload.get("prompt")),
    "candidate_code": optional_code(payload.get("candidate_code") or candidate.get("code")),
    "candidate_name": text(payload.get("candidate_name") or candidate.get("name")) or None,
    "source_count": integer(payload.get("source_count"), 0),
    "active": boolean(payload.get("active"), True),
  }


def main() -> None:
  result = normalize(read_payload())
  supabase(
    f"{RESULT_TABLE}?on_conflict=trade_date",
    method="POST",
    body=result,
    prefer="resolution=merge-duplicates,return=minimal",
  )
  print(json.dumps({"written": True, "trade_date": result["trade_date"], "title": result["title"]}, ensure_ascii=False))


if __name__ == "__main__":
  main()
