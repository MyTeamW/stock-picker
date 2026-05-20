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


def first_dict(*values: Any) -> dict[str, Any]:
  for value in values:
    if isinstance(value, dict):
      return value
  return {}


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


def normalize_buy_recommendation(payload: dict[str, Any]) -> dict[str, Any]:
  candidate = first_dict(payload.get("candidate"))
  buy = first_dict(payload.get("buy_recommendation"), payload.get("buyRecommendation"))
  title = text(buy.get("title") or payload.get("title"))
  summary = text(buy.get("summary") or payload.get("summary"))
  rationale = text_list(buy.get("rationale") or buy.get("reasons") or payload.get("rationale"))
  risks = text_list(buy.get("risks") or payload.get("risks"))
  action = text(buy.get("action") or payload.get("action"))
  candidate_code = optional_code(
    buy.get("candidate_code") or buy.get("candidateCode") or payload.get("candidate_code") or candidate.get("code")
  )
  candidate_name = text(
    buy.get("candidate_name") or buy.get("candidateName") or payload.get("candidate_name") or candidate.get("name")
  )

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
    "title": title,
    "summary": summary,
    "candidate_code": candidate_code,
    "candidate_name": candidate_name or None,
    "rationale": rationale,
    "risks": risks,
    "action": action,
  }


def normalize_holding_advice(payload: dict[str, Any]) -> list[dict[str, Any]]:
  raw = payload.get("holding_advice", payload.get("holdingAdvice"))
  if isinstance(raw, dict) and isinstance(raw.get("items"), list):
    raw = raw["items"]
  if not isinstance(raw, list):
    return []

  advice: list[dict[str, Any]] = []
  for item in raw:
    if not isinstance(item, dict):
      continue
    normalized = {
      "code": optional_code(item.get("code") or item.get("candidate_code")),
      "name": text(item.get("name") or item.get("candidate_name")) or None,
      "base_position": text(item.get("base_position") or item.get("basePosition") or item.get("position")),
      "summary": text(item.get("summary")),
      "action": text(item.get("action")),
      "rationale": text_list(item.get("rationale") or item.get("reasons")),
      "risks": text_list(item.get("risks")),
    }
    if any(normalized.get(key) for key in ("code", "name", "summary", "action")):
      advice.append(normalized)
  return advice


def normalize(payload: dict[str, Any]) -> dict[str, Any]:
  buy = normalize_buy_recommendation(payload)
  holding_advice = normalize_holding_advice(payload)
  has_structured = "buy_recommendation" in payload or "buyRecommendation" in payload or "holding_advice" in payload or "holdingAdvice" in payload
  prompt = text(payload.get("prompt"))
  if has_structured:
    prompt = json.dumps(
      {
        "version": 2,
        "buy_recommendation": buy,
        "holding_advice": holding_advice,
      },
      ensure_ascii=False,
      separators=(",", ":"),
    )

  return {
    "trade_date": text(payload.get("trade_date")) or now_china().date().isoformat(),
    "generated_at": text(payload.get("generated_at")) or now_china().isoformat(),
    "title": buy["title"],
    "summary": buy["summary"],
    "rationale": buy["rationale"],
    "risks": buy["risks"],
    "action": buy["action"],
    "prompt": prompt,
    "candidate_code": buy["candidate_code"],
    "candidate_name": buy["candidate_name"],
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
