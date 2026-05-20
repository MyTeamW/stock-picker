from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime
from http.client import RemoteDisconnected
from typing import Any
from urllib.error import HTTPError, URLError
from zoneinfo import ZoneInfo

try:
  from run_picker_automation import (
    RESULT_TABLE,
    SETTINGS_ROW_KEY,
    SETTINGS_TABLE,
    STOCK_TABLE,
    fetch_quote,
    load_settings,
    merge_quote,
    money,
    normalize_percent_value,
    percent,
    plain_number,
    refresh_stocks,
    score_stock,
    supabase,
  )
except ModuleNotFoundError:
  from scripts.run_picker_automation import (
    RESULT_TABLE,
    SETTINGS_ROW_KEY,
    SETTINGS_TABLE,
    STOCK_TABLE,
    fetch_quote,
    load_settings,
    merge_quote,
    money,
    normalize_percent_value,
    percent,
    plain_number,
    refresh_stocks,
    score_stock,
    supabase,
  )


CHINA_TZ = ZoneInfo("Asia/Shanghai")
PAGE_URL = "https://myteamw.github.io/stock-picker/"
TRACKER_URL = "https://myteamw.github.io/tracker/"
TRACKER_STOCK_TABLE = os.environ.get("TRACKER_STOCK_TABLE") or "stocks"
BIG_POOL_REFRESH_LIMIT = int(os.environ.get("PICKER_BIG_POOL_REFRESH_LIMIT") or "180")


def now_china() -> datetime:
  return datetime.now(CHINA_TZ)


def compact_money(value: Any) -> str:
  try:
    number = float(value)
  except (TypeError, ValueError):
    return "-"
  if number <= 0:
    return "-"
  if number >= 100_000_000:
    return f"{number / 100_000_000:.2f}亿"
  if number >= 10_000:
    return f"{number / 10_000:.2f}万"
  return f"{number:.0f}"


def ratio_percent(current: Any, base: Any) -> float | None:
  current_number = plain_number(current)
  base_number = plain_number(base)
  if current_number is None or base_number is None:
    return None
  return ((current_number - base_number) / base_number) * 100


def direct_percent(value: Any) -> str:
  try:
    number = float(value)
  except (TypeError, ValueError):
    return "-"
  return f"{number:.2f}%"


def useful_stock_name(name: Any, code: Any) -> str:
  text = str(name or "").strip()
  clean_code = str(code or "").strip()
  if text and not (re.fullmatch(r"\d{6}", text) and text == clean_code):
    return text
  return clean_code


def base_position_for(stock: dict[str, Any], settings: dict[str, Any]) -> str:
  code = str(stock.get("code") or "")
  stock_value = str(stock.get("base_position") or stock.get("basePosition") or "").strip()
  if stock_value:
    return stock_value
  base_positions = settings.get("basePositions")
  if isinstance(base_positions, dict):
    return str(base_positions.get(code) or "").strip()
  return ""


def format_base_position(value: Any) -> str:
  text = str(value or "").strip()
  return re.sub(r"\s*\n+\s*", "；", text)


def normalize_stock(stock: dict[str, Any], settings: dict[str, Any] | None = None) -> dict[str, Any]:
  settings = settings or {}
  quote_date = str(stock.get("quote_date") or "")
  if not is_valid_date(quote_date):
    refreshed_at = str(stock.get("refreshed_at") or "")
    quote_date = refreshed_at[:10] if re.fullmatch(r"\d{4}-\d{2}-\d{2}.*", refreshed_at) else ""
  return {
    "code": stock.get("code"),
    "name": useful_stock_name(stock.get("name"), stock.get("code")),
    "remark": stock.get("remark") or "",
    "business": stock.get("business") or "",
    "base_position": base_position_for(stock, settings),
    "price": stock.get("price"),
    "high": stock.get("high"),
    "low": stock.get("low"),
    "open": stock.get("open"),
    "previous_close": stock.get("previous_close"),
    "change_amount": stock.get("change_amount"),
    "change_percent": normalize_percent_value(stock.get("change_percent")),
    "volume": stock.get("volume"),
    "turnover": stock.get("turnover"),
    "quote_date": quote_date or None,
    "refreshed_at": stock.get("refreshed_at"),
  }


def normalize_big_pool_stock(stock: dict[str, Any]) -> dict[str, Any]:
  start_price = plain_number(stock.get("start_price"))
  high_price = plain_number(stock.get("high_price") or stock.get("high"))
  close_price = plain_number(stock.get("close_price") or stock.get("price"))
  latest_price = plain_number(stock.get("price")) or close_price
  quote_date = str(stock.get("quote_date") or stock.get("last_quote_date") or "")
  if not is_valid_date(quote_date):
    refreshed_at = str(stock.get("refreshed_at") or "")
    quote_date = refreshed_at[:10] if re.fullmatch(r"\d{4}-\d{2}-\d{2}.*", refreshed_at) else ""
  return {
    "code": stock.get("code"),
    "name": useful_stock_name(stock.get("name"), stock.get("code")),
    "remark": stock.get("remark") or "",
    "recommender": stock.get("recommender") or "",
    "start_date": stock.get("start_date") or "",
    "start_price": start_price,
    "high_price": high_price,
    "close_price": close_price,
    "price": latest_price,
    "high": plain_number(stock.get("high")) or high_price,
    "low": plain_number(stock.get("low")),
    "open": plain_number(stock.get("open")),
    "previous_close": plain_number(stock.get("previous_close")),
    "change_percent": normalize_percent_value(stock.get("change_percent")),
    "turnover": plain_number(stock.get("turnover")),
    "increase_percent": ratio_percent(high_price, start_price),
    "high_drawdown_percent": ratio_percent(latest_price, high_price),
    "start_drawdown_percent": ratio_percent(latest_price, start_price),
    "quote_date": quote_date or None,
    "last_quote_date": stock.get("last_quote_date"),
    "refreshed_at": stock.get("refreshed_at"),
  }


def refresh_big_pool_quotes(stocks: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
  refreshed: list[dict[str, Any]] = []
  errors: list[str] = []
  for index, stock in enumerate(stocks):
    code = str(stock.get("code") or "")
    if index >= BIG_POOL_REFRESH_LIMIT:
      refreshed.append(stock)
      continue
    try:
      refreshed.append(merge_quote(stock, fetch_quote(code)))
      time.sleep(0.08)
    except (HTTPError, URLError, TimeoutError, RemoteDisconnected, RuntimeError, ValueError) as exc:
      errors.append(f"{code}: {exc}")
      refreshed.append(stock)
  return refreshed, errors


def is_valid_date(value: str) -> bool:
  if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
    return False
  try:
    parsed = datetime.fromisoformat(value)
  except ValueError:
    return False
  return 2000 <= parsed.year <= 2100


def candidate_line(stock: dict[str, Any], index: int, settings: dict[str, Any]) -> str:
  base_position = format_base_position(base_position_for(stock, settings)) or "未填写"
  return (
    f"{index}. {useful_stock_name(stock.get('name'), stock.get('code'))}（{stock.get('code')}）："
    f"现价{money(stock.get('price'))}元，涨跌幅{percent(stock.get('change_percent'))}，"
    f"今高/今低{money(stock.get('high'))}/{money(stock.get('low'))}，"
    f"开盘/昨收{money(stock.get('open'))}/{money(stock.get('previous_close'))}，"
    f"底仓明细：{base_position}，备注："
    f"{stock.get('remark') or stock.get('business') or '无'}"
  )


def big_pool_line(stock: dict[str, Any], index: int) -> str:
  normalized = normalize_big_pool_stock(stock)
  return (
    f"{index}. {useful_stock_name(normalized.get('name'), normalized.get('code'))}（{normalized.get('code')}）："
    f"最新价{money(normalized.get('price'))}元，起始价{money(normalized.get('start_price'))}元，"
    f"最高价{money(normalized.get('high_price'))}元，最高涨幅{direct_percent(normalized.get('increase_percent'))}，"
    f"高位回撤{direct_percent(normalized.get('high_drawdown_percent'))}，"
    f"今日涨跌幅{percent(normalized.get('change_percent'))}，"
    f"更新时间{normalized.get('quote_date') or normalized.get('last_quote_date') or '-'}，"
    f"备注：{normalized.get('remark') or normalized.get('recommender') or '无'}"
  )


def score_big_pool_stock(stock: dict[str, Any], settings: dict[str, Any]) -> float:
  normalized = normalize_big_pool_stock(stock)
  price = plain_number(normalized.get("price"))
  if price is None:
    return -999
  if price < float(settings["minPrice"]) or price > float(settings["maxPrice"]):
    return -999
  name = str(normalized.get("name") or "")
  if "ST" in name.upper() or "退" in name:
    return -999

  score = 0.0
  score += 18 if 6 <= price <= 60 else 8
  daily_change = normalize_percent_value(normalized.get("change_percent"))
  if isinstance(daily_change, (int, float)):
    if -1.5 <= daily_change <= 4.5:
      score += 26
    elif 4.5 < daily_change <= 7.5:
      score += 17
    elif -4 <= daily_change < -1.5:
      score += 12
    else:
      score += 4

  high_drawdown = normalized.get("high_drawdown_percent")
  if isinstance(high_drawdown, (int, float)):
    if -16 <= high_drawdown <= -2:
      score += 22
    elif -2 < high_drawdown <= 3:
      score += 14
    elif -28 <= high_drawdown < -16:
      score += 8

  start_gain = normalized.get("start_drawdown_percent")
  if isinstance(start_gain, (int, float)):
    if 0 <= start_gain <= 45:
      score += 16
    elif 45 < start_gain <= 90:
      score += 9
    elif -12 <= start_gain < 0:
      score += 6

  turnover = plain_number(normalized.get("turnover"))
  if turnover:
    if turnover >= 500_000_000:
      score += 16
    elif turnover >= 100_000_000:
      score += 10
    elif turnover >= 30_000_000:
      score += 5

  theme = f"{normalized.get('remark', '')} {normalized.get('recommender', '')}"
  if re.search(r"通信|电力|新能源|半导体|智能|光|电子|材料|算力|AI", theme):
    score += 8
  if str(normalized.get("code") or "").startswith(("688", "300", "301")):
    score -= 3
  return score


def held_stocks(stocks: list[dict[str, Any]], settings: dict[str, Any]) -> list[dict[str, Any]]:
  return [stock for stock in stocks if base_position_for(stock, settings)]


def build_default_prompt(
  settings: dict[str, Any],
  big_pool_ranked: list[tuple[float, dict[str, Any]]],
  big_pool_stocks: list[dict[str, Any]],
  holdings: list[dict[str, Any]],
) -> str:
  big_candidate_source = [stock for _, stock in big_pool_ranked[:12]] or big_pool_stocks[:12]
  big_candidates = "\n".join(big_pool_line(stock, index) for index, stock in enumerate(big_candidate_source, 1))
  if not big_candidates:
    big_candidates = "暂无可用大池股票。"

  holding_candidates = "\n".join(candidate_line(stock, index, settings) for index, stock in enumerate(holdings, 1))
  if not holding_candidates:
    holding_candidates = "暂无已填写底仓的持仓股票。"

  return (
    "请你作为谨慎的 A 股短线助手，今天要分开完成两个部分。\n\n"
    f"今日选股推荐：从大池子（{TRACKER_URL}）中只推荐 1 只今日买入观察标的；"
    "以交易日 14:30 附近行情为主，可参考大池历史最高价、回撤、备注和流动性，"
    "但不要机械照搬页面排序。\n\n"
    "持仓操作建议：只对已经持仓的股票给后续操作建议；是否持仓以“底仓明细”非空为准，"
    "未填写底仓明细的股票不当作持仓处理。\n\n"
    f"我的设置：价格区间 {money(settings.get('minPrice'))} - {money(settings.get('maxPrice'))} 元；"
    f"默认选股时间 {settings.get('pickTime') or '14:30'}；计划买入 {int(settings.get('lot') or 1)} 手"
    f"（{int(settings.get('lot') or 1) * 100} 股）。\n\n"
    f"大池候选摘要：\n{big_candidates}\n\n"
    f"已持仓股票：\n{holding_candidates}"
    "\n\n请输出两部分：第一部分是今日新买推荐，必须包含推荐股票、推荐理由、风险、理想买点、"
    "止损位、短线目标区间和买入量提醒；第二部分是每只持仓股的后续操作建议，明确持有、减仓、"
    "观察或止损条件。所有内容都要写明不构成投资建议。"
  )


def build_combined_prompt(default_prompt: str, user_requirements: str) -> str:
  user_text = user_requirements.strip() or "无额外手动要求。"
  return f"{default_prompt}\n\n我的要求（用户手动输入）：\n{user_text}"


def persist_default_prompt(settings: dict[str, Any], default_prompt: str) -> None:
  updated = dict(settings)
  updated["defaultPrompt"] = default_prompt
  updated["pickTime"] = "14:30"
  supabase(
    f"{SETTINGS_TABLE}?on_conflict=key",
    method="POST",
    body={"key": SETTINGS_ROW_KEY, "value": updated},
    prefer="resolution=merge-duplicates,return=minimal",
  )


def build_writer_schema() -> dict[str, str]:
  return {
    "title": "兼容字段，展示今日选股推荐标题，例如 今日推荐：某某（000000）",
    "summary": "兼容字段，1-2 句概括今日选股推荐结论，需写明不构成投资建议",
    "rationale": "兼容字段，字符串数组，列出今日选股推荐选择依据",
    "risks": "兼容字段，字符串数组，列出今日选股推荐主要风险和放弃条件",
    "action": "兼容字段，今日选股推荐短线操作建议，包含不追高、理想买点、止损、目标、买入量提醒",
    "buy_recommendation": "必填对象，字段为 title、summary、candidate_code、candidate_name、rationale(数组)、risks(数组)、action；表示从大池子中推荐的 1 只今日买入观察标的",
    "holding_advice": "必填数组；每项字段为 code、name、base_position、summary、action、rationale(数组)、risks(数组)；仅包含底仓明细非空的持仓股，没有持仓则为空数组",
    "prompt": "可选，通常留空；结构化结果会被写入 picker_results.prompt 供页面分区渲染",
    "candidate_code": "可选，今日选股推荐 6 位股票代码；没有候选时为 null",
    "candidate_name": "可选，今日选股推荐股票简称；没有候选时为 null",
    "source_count": "可选，本次读取的大池股票数量",
  }


def main() -> None:
  refresh_quotes = "--refresh-quotes" in sys.argv
  holding_rows = supabase(f"{STOCK_TABLE}?select=*&deleted=eq.false&order=created_at.desc,code.asc")
  if not isinstance(holding_rows, list):
    raise RuntimeError("holding stock query did not return a list")

  big_pool_rows = supabase(f"{TRACKER_STOCK_TABLE}?select=*&deleted=eq.false&order=created_at.desc,code.asc")
  if not isinstance(big_pool_rows, list):
    raise RuntimeError("big pool stock query did not return a list")

  quote_errors: list[str] = []
  big_pool_quote_errors: list[str] = []
  stocks = holding_rows
  big_pool_stocks = big_pool_rows
  if refresh_quotes:
    stocks, quote_errors = refresh_stocks(holding_rows)
    big_pool_stocks, big_pool_quote_errors = refresh_big_pool_quotes(big_pool_rows)

  settings = load_settings()
  settings["pickTime"] = "14:30"
  holding_list = held_stocks(stocks, settings)
  big_pool_ranked = sorted(
    [(score_big_pool_stock(stock, settings), stock) for stock in big_pool_stocks],
    key=lambda item: item[0],
    reverse=True,
  )
  big_pool_ranked = [(score, stock) for score, stock in big_pool_ranked if score > 0]
  holding_ranked = sorted(
    [(score_stock(stock, settings), stock) for stock in holding_list],
    key=lambda item: item[0],
    reverse=True,
  )
  holding_ranked = [(score, stock) for score, stock in holding_ranked if score > 0]
  default_prompt = build_default_prompt(settings, big_pool_ranked, big_pool_stocks, holding_list)
  persist_default_prompt(settings, default_prompt)
  settings["defaultPrompt"] = default_prompt
  user_requirements = str(settings.get("userRequirements") or "")
  combined_prompt = build_combined_prompt(default_prompt, user_requirements)

  context = {
    "trade_date": now_china().date().isoformat(),
    "generated_at": now_china().isoformat(),
    "page_url": PAGE_URL,
    "big_pool_url": TRACKER_URL,
    "source_tables": {
      "big_pool_stocks": TRACKER_STOCK_TABLE,
      "holding_stocks": STOCK_TABLE,
      "results": RESULT_TABLE,
    },
    "settings": settings,
    "big_pool_stocks": [normalize_big_pool_stock(stock) for stock in big_pool_stocks],
    "big_pool_ranked_candidates": [
      {"score": round(score, 2), **normalize_big_pool_stock(stock)} for score, stock in big_pool_ranked[:20]
    ],
    "holding_stocks": [normalize_stock(stock, settings) for stock in holding_list],
    "holding_ranked_candidates": [
      {"score": round(score, 2), **normalize_stock(stock, settings)} for score, stock in holding_ranked[:12]
    ],
    "watchlist_stocks": [normalize_stock(stock, settings) for stock in stocks],
    "stocks": [normalize_big_pool_stock(stock) for stock in big_pool_stocks],
    "ranked_candidates": [
      {"score": round(score, 2), **normalize_big_pool_stock(stock)} for score, stock in big_pool_ranked[:20]
    ],
    "quote_errors": quote_errors[:20],
    "big_pool_quote_errors": big_pool_quote_errors[:20],
    "big_pool_quote_refresh_limit": BIG_POOL_REFRESH_LIMIT,
    "default_prompt": default_prompt,
    "user_requirements": user_requirements,
    "combined_prompt": combined_prompt,
    "page_prompt": combined_prompt,
    "write_result_schema": build_writer_schema(),
    "next_step": (
      "Use default_prompt, user_requirements, big_pool_stocks, big_pool_ranked_candidates, holding_stocks, and refreshed quote data to reason in Codex. "
      "Generate a two-part result JSON with buy_recommendation and holding_advice, then pass only the final JSON to scripts/write_codex_result.py. "
      "Do not use GitHub Actions for the daily analysis."
    ),
  }
  print(json.dumps(context, ensure_ascii=False, indent=2))


if __name__ == "__main__":
  main()
