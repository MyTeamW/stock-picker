from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime
from http.client import RemoteDisconnected
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


def env_or(name: str, fallback: str) -> str:
  return os.environ.get(name) or fallback


SUPABASE_URL = env_or("PICKER_SUPABASE_URL", "https://kawztespuaiztftoifdk.supabase.co").rstrip("/")
SUPABASE_KEY = env_or("PICKER_SUPABASE_KEY", "sb_publishable_Ydf2JJK06d4GMTE2awOSwg_3GZLTR27")
STOCK_TABLE = env_or("PICKER_STOCK_TABLE", "picker_stocks")
SETTINGS_TABLE = env_or("PICKER_SETTINGS_TABLE", "picker_settings")
RESULT_TABLE = env_or("PICKER_RESULT_TABLE", "picker_results")
SETTINGS_ROW_KEY = "default"

CHINA_TZ = ZoneInfo("Asia/Shanghai")


@dataclass
class Quote:
  code: str
  name: str
  price: float | None
  high: float | None
  low: float | None
  open: float | None
  previous_close: float | None
  change_amount: float | None
  change_percent: float | None
  volume: float | None
  turnover: float | None
  quote_date: str


def now_china() -> datetime:
  return datetime.now(CHINA_TZ)


def normalize_code(value: str) -> str:
  code = re.sub(r"\D", "", value or "")[:6]
  if len(code) != 6:
    raise ValueError(f"invalid stock code: {value}")
  return code


def exchange_prefix(code: str) -> str:
  return "1" if code.startswith(("6", "9")) else "0"


def scaled(value: Any, scale: int = 100) -> float | None:
  try:
    number = float(value)
  except (TypeError, ValueError):
    return None
  if number <= 0:
    return None
  return number / scale


def signed_scaled(value: Any, scale: int = 100) -> float | None:
  try:
    number = float(value)
  except (TypeError, ValueError):
    return None
  return number / scale


def normalize_percent_value(value: Any) -> float | None:
  try:
    number = float(value)
  except (TypeError, ValueError):
    return None
  if abs(number) > 30:
    return number / 100
  return number


def plain_number(value: Any) -> float | None:
  try:
    number = float(value)
  except (TypeError, ValueError):
    return None
  return number if number > 0 else None


def quote_date(raw: Any) -> str:
  text = str(raw or "")
  if re.fullmatch(r"\d{14}", text):
    return f"{text[:4]}-{text[4:6]}-{text[6:8]}"
  if re.fullmatch(r"\d{13}", text):
    return datetime.fromtimestamp(int(text) / 1000, CHINA_TZ).date().isoformat()
  if re.fullmatch(r"\d{10}", text):
    return datetime.fromtimestamp(int(text), CHINA_TZ).date().isoformat()
  if re.fullmatch(r"\d{8}", text):
    return f"{text[:4]}-{text[4:6]}-{text[6:8]}"
  return now_china().date().isoformat()


def request_json(url: str, *, method: str = "GET", body: Any = None, headers: dict[str, str] | None = None) -> Any:
  payload = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
  request_headers = {
    "User-Agent": "Mozilla/5.0 StockPickerAutomation/1.0",
    "Accept": "application/json,text/plain,*/*",
  }
  if "eastmoney.com" in url:
    request_headers["Referer"] = "https://quote.eastmoney.com/"
  if headers:
    request_headers.update(headers)
  request = Request(url, data=payload, method=method, headers=request_headers)
  with urlopen(request, timeout=15) as response:
    if response.status == 204:
      return None
    text = response.read().decode("utf-8")
    if not text.strip():
      return None
    return json.loads(text)


def supabase_headers(extra: dict[str, str] | None = None) -> dict[str, str]:
  headers = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
  }
  if extra:
    headers.update(extra)
  return headers


def supabase(path: str, *, method: str = "GET", body: Any = None, prefer: str | None = None) -> Any:
  headers = supabase_headers({"Prefer": prefer} if prefer else None)
  url = f"{SUPABASE_URL}/rest/v1/{path}"
  return request_json(url, method=method, body=body, headers=headers)


def fetch_quote(code: str) -> Quote:
  clean = normalize_code(code)
  params = {
    "secid": f"{exchange_prefix(clean)}.{clean}",
    "fields": "f43,f44,f45,f46,f47,f48,f57,f58,f60,f86,f169,f170",
  }
  payload = request_json("https://push2.eastmoney.com/api/qt/stock/get?" + urlencode(params))
  data = payload.get("data") if isinstance(payload, dict) else None
  if not data:
    raise RuntimeError(f"no quote data for {clean}")
  return Quote(
    code=normalize_code(data.get("f57") or clean),
    name=data.get("f58") or clean,
    price=scaled(data.get("f43")),
    high=scaled(data.get("f44")),
    low=scaled(data.get("f45")),
    open=scaled(data.get("f46")),
    previous_close=scaled(data.get("f60")),
    change_amount=signed_scaled(data.get("f169")),
    change_percent=signed_scaled(data.get("f170")),
    volume=plain_number(data.get("f47")),
    turnover=plain_number(data.get("f48")),
    quote_date=quote_date(data.get("f86")),
  )


def merge_quote(stock: dict[str, Any], quote: Quote) -> dict[str, Any]:
  return {
    **stock,
    "code": quote.code,
    "name": stock.get("name") or quote.name,
    "price": quote.price,
    "high": quote.high,
    "low": quote.low,
    "open": quote.open,
    "previous_close": quote.previous_close,
    "change_amount": quote.change_amount,
    "change_percent": quote.change_percent,
    "volume": quote.volume,
    "turnover": quote.turnover,
    "quote_date": quote.quote_date,
    "refreshed_at": now_china().isoformat(),
  }


def stock_payload(stock: dict[str, Any]) -> dict[str, Any]:
  return {
    "code": stock["code"],
    "name": stock.get("name") or stock["code"],
    "remark": stock.get("remark") or "",
    "business": stock.get("business") or "",
    "price": stock.get("price"),
    "high": stock.get("high"),
    "low": stock.get("low"),
    "open": stock.get("open"),
    "previous_close": stock.get("previous_close"),
    "change_amount": stock.get("change_amount"),
    "change_percent": normalize_percent_value(stock.get("change_percent")),
    "volume": stock.get("volume"),
    "turnover": stock.get("turnover"),
    "quote_date": stock.get("quote_date"),
    "refreshed_at": stock.get("refreshed_at"),
    "deleted": bool(stock.get("deleted")),
  }


def refresh_stocks(stocks: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
  refreshed: list[dict[str, Any]] = []
  errors: list[str] = []
  for stock in stocks:
    code = stock.get("code") or ""
    try:
      refreshed_stock = merge_quote(stock, fetch_quote(code))
      refreshed.append(refreshed_stock)
      supabase(
        f"{STOCK_TABLE}?on_conflict=code",
        method="POST",
        body=stock_payload(refreshed_stock),
        prefer="resolution=merge-duplicates,return=minimal",
      )
      time.sleep(0.12)
    except (HTTPError, URLError, TimeoutError, RemoteDisconnected, RuntimeError, ValueError) as exc:
      errors.append(f"{code}: {exc}")
      refreshed.append(stock)
  return refreshed, errors


def load_settings() -> dict[str, Any]:
  settings = {"minPrice": 0, "maxPrice": 70, "pickTime": "14:30", "lot": 1}
  try:
    rows = supabase(f"{SETTINGS_TABLE}?select=value&key=eq.{SETTINGS_ROW_KEY}&limit=1")
  except Exception:
    return settings
  if isinstance(rows, list) and rows and isinstance(rows[0].get("value"), dict):
    settings.update(rows[0]["value"])
  settings["pickTime"] = "14:30"
  return settings


def score_stock(stock: dict[str, Any], settings: dict[str, Any]) -> float:
  price = plain_number(stock.get("price"))
  change = normalize_percent_value(stock.get("change_percent"))
  high = plain_number(stock.get("high"))
  low = plain_number(stock.get("low"))
  turnover = plain_number(stock.get("turnover"))
  if price is None:
    return -999
  if price < float(settings["minPrice"]) or price > float(settings["maxPrice"]):
    return -999
  if "ST" in str(stock.get("name", "")).upper() or "退" in str(stock.get("name", "")):
    return -999

  score = 0.0
  score += 18 if 6 <= price <= 60 else 8
  if isinstance(change, (int, float)):
    if -1.5 <= change <= 4.5:
      score += 28
    elif 4.5 < change <= 7.5:
      score += 18
    elif -4 <= change < -1.5:
      score += 12
    else:
      score += 4
  else:
    score += 8

  if high and low and high > low:
    intraday_position = (price - low) / (high - low)
    if 0.35 <= intraday_position <= 0.78:
      score += 24
    elif intraday_position < 0.35:
      score += 14
    else:
      score += 8

  if turnover:
    if turnover >= 500_000_000:
      score += 18
    elif turnover >= 100_000_000:
      score += 12
    elif turnover >= 30_000_000:
      score += 6

  theme = f"{stock.get('remark', '')} {stock.get('business', '')}"
  if re.search(r"通信|电力|新能源|半导体|智能|光|电子|材料|算力|AI", theme):
    score += 10
  if str(stock.get("code", "")).startswith(("688", "300", "301")):
    score -= 3
  return score


def money(value: Any) -> str:
  try:
    return f"{float(value):.2f}"
  except (TypeError, ValueError):
    return "-"


def percent(value: Any) -> str:
  number = normalize_percent_value(value)
  if number is None:
    return "-"
  return f"{number:.2f}%"


def build_result(stocks: list[dict[str, Any]], settings: dict[str, Any], errors: list[str]) -> dict[str, Any]:
  today = now_china().date().isoformat()
  ranked = sorted(
    [(score_stock(stock, settings), stock) for stock in stocks],
    key=lambda item: item[0],
    reverse=True,
  )
  ranked = [(score, stock) for score, stock in ranked if score > 0]

  if not ranked:
    return {
      "trade_date": today,
      "generated_at": now_china().isoformat(),
      "title": "今日未生成观察候选",
      "summary": f"股票池 {len(stocks)} 只，未找到同时满足价格、行情和风险过滤的标的；不构成投资建议。",
      "rationale": ["价格区间、ST/退市风险、行情完整度过滤后无合格候选"],
      "risks": ["信息不足时不强行推荐", f"行情刷新失败 {len(errors)} 只"],
      "action": "今天不新开观察仓，先维护股票池和行情质量。",
      "prompt": "",
      "candidate_code": None,
      "candidate_name": None,
      "source_count": len(stocks),
      "active": True,
    }

  score, stock = ranked[0]
  price = float(stock["price"])
  buy_low = price * 0.985
  buy_high = price * 1.005
  stop = price * 0.955
  target_1 = max(price * 1.045, float(stock.get("high") or price))
  target_2 = price * 1.08
  top_names = "、".join(f"{item[1].get('name')}({item[1].get('code')})" for item in ranked[:3])

  return {
    "trade_date": today,
    "generated_at": now_china().isoformat(),
    "title": f"今日观察候选：{stock.get('name')}（{stock.get('code')}）",
    "summary": f"基于独立股票池 {len(stocks)} 只，规则评分 {score:.1f}；仅作观察，不构成投资建议。",
    "rationale": [
      f"现价 {money(price)} 元，位于 {money(settings['minPrice'])}-{money(settings['maxPrice'])} 元区间，计划买入量 {int(settings.get('lot') or 1)} 手",
      f"日内高/低 {money(stock.get('high'))}/{money(stock.get('low'))}，涨跌幅 {percent(stock.get('change_percent'))}，成交额 {money((stock.get('turnover') or 0) / 100000000)} 亿",
      f"主题备注：{stock.get('remark') or stock.get('business') or '无'}",
      f"同池高分候选：{top_names}",
    ],
    "risks": [
      "规则只处理价格、涨跌幅、日内位置和成交额，不能替代基本面和盘中盘口判断",
      "若跌破止损位或放量转弱，放弃低吸计划",
      f"行情刷新失败 {len(errors)} 只，需确认数据源稳定性",
    ],
    "action": f"不追高；理想关注 {money(buy_low)}-{money(buy_high)} 元，止损 {money(stop)} 元，目标先看 {money(target_1)}-{money(target_2)} 元，最多 {int(settings.get('lot') or 1)} 手试错。",
    "prompt": (
      "请你作为谨慎的 A 股分析助手，每个交易日从股票池中推荐 1 只今日买入观察标的。"
      f"页面本地排序第一名：{stock.get('name')}（{stock.get('code')}），现价 {money(price)} 元，"
      f"涨跌幅 {percent(stock.get('change_percent'))}，日内高/低 {money(stock.get('high'))}/{money(stock.get('low'))}。"
      "请根据完整股票池和今日行情独立给出最终推荐、风险点、仓位提醒，并明确不构成投资建议。"
    ),
    "candidate_code": stock.get("code"),
    "candidate_name": stock.get("name"),
    "source_count": len(stocks),
    "active": True,
  }


def write_result(result: dict[str, Any]) -> None:
  supabase(
    f"{RESULT_TABLE}?on_conflict=trade_date",
    method="POST",
    body=result,
    prefer="resolution=merge-duplicates,return=minimal",
  )


def main() -> None:
  settings = load_settings()
  stocks = supabase(f"{STOCK_TABLE}?select=*&deleted=eq.false&order=created_at.desc,code.asc")
  if not isinstance(stocks, list):
    raise RuntimeError("stock query did not return a list")
  refreshed, errors = refresh_stocks(stocks)
  result = build_result(refreshed, settings, errors)
  write_result(result)
  print(json.dumps({"result": result, "quoteErrors": errors[:10]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
  main()
