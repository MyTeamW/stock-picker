from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta
from typing import Any

try:
  from run_picker_automation import SETTINGS_TABLE, now_china, supabase
except ModuleNotFoundError:
  from scripts.run_picker_automation import SETTINGS_TABLE, now_china, supabase


MANUAL_REQUEST_ROW_KEY = "manual-recommendation"
STALE_AFTER = timedelta(minutes=45)


def load_request() -> dict[str, Any] | None:
  rows = supabase(f"{SETTINGS_TABLE}?select=value&key=eq.{MANUAL_REQUEST_ROW_KEY}&limit=1")
  if not isinstance(rows, list) or not rows or not isinstance(rows[0].get("value"), dict):
    return None
  return dict(rows[0]["value"])


def save_request(request: dict[str, Any]) -> None:
  supabase(
    f"{SETTINGS_TABLE}?on_conflict=key",
    method="POST",
    body={"key": MANUAL_REQUEST_ROW_KEY, "value": request},
    prefer="resolution=merge-duplicates,return=minimal",
  )


def parse_time(value: Any) -> datetime | None:
  text = str(value or "").strip()
  if not text:
    return None
  try:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))
  except ValueError:
    return None


def request_is_stale(request: dict[str, Any]) -> bool:
  started_at = parse_time(request.get("startedAt"))
  if started_at is None:
    return True
  return now_china().astimezone(started_at.tzinfo) - started_at >= STALE_AFTER


def request_is_actionable(request: dict[str, Any] | None) -> bool:
  if not request or not str(request.get("id") or "").strip() or not str(request.get("prompt") or "").strip():
    return False
  status = str(request.get("status") or "").strip().lower()
  return status == "pending" or (status == "processing" and request_is_stale(request))


def claim_request(request_id: str) -> dict[str, Any]:
  request = load_request()
  if not request or str(request.get("id") or "") != request_id or not request_is_actionable(request):
    return {"claimed": False, "request": request}
  request["status"] = "processing"
  request["startedAt"] = now_china().isoformat()
  request.pop("completedAt", None)
  request.pop("resultGeneratedAt", None)
  request.pop("error", None)
  save_request(request)
  return {"claimed": True, "request": request}


def complete_request(request_id: str, result_generated_at: str = "") -> dict[str, Any]:
  request = load_request()
  if not request or str(request.get("id") or "") != request_id:
    return {"completed": False, "request": request}
  request["status"] = "completed"
  request["completedAt"] = now_china().isoformat()
  request["resultGeneratedAt"] = result_generated_at or request["completedAt"]
  request.pop("error", None)
  save_request(request)
  return {"completed": True, "request": request}


def fail_request(request_id: str, message: str) -> dict[str, Any]:
  request = load_request()
  if not request or str(request.get("id") or "") != request_id:
    return {"failed": False, "request": request}
  request["status"] = "failed"
  request["completedAt"] = now_china().isoformat()
  request["error"] = str(message or "荐股任务执行失败").strip()
  save_request(request)
  return {"failed": True, "request": request}


def main() -> None:
  parser = argparse.ArgumentParser(description="Read and update the manual stock recommendation request.")
  subparsers = parser.add_subparsers(dest="command", required=True)
  subparsers.add_parser("check")
  claim = subparsers.add_parser("claim")
  claim.add_argument("--id", required=True)
  complete = subparsers.add_parser("complete")
  complete.add_argument("--id", required=True)
  complete.add_argument("--result-generated-at", default="")
  fail = subparsers.add_parser("fail")
  fail.add_argument("--id", required=True)
  fail.add_argument("--message", default="荐股任务执行失败")
  args = parser.parse_args()

  if args.command == "check":
    request = load_request()
    output = {"actionable": request_is_actionable(request), "request": request}
  elif args.command == "claim":
    output = claim_request(args.id)
  elif args.command == "complete":
    output = complete_request(args.id, args.result_generated_at)
  else:
    output = fail_request(args.id, args.message)
  print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
  main()
