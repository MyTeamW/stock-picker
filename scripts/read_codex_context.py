from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

try:
  from run_picker_automation import (
    RESULT_TABLE,
    SETTINGS_ROW_KEY,
    SETTINGS_TABLE,
    STOCK_TABLE,
    load_settings,
    money,
    normalize_percent_value,
    percent,
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
    load_settings,
    money,
    normalize_percent_value,
    percent,
    refresh_stocks,
    score_stock,
    supabase,
  )


CHINA_TZ = ZoneInfo("Asia/Shanghai")
PAGE_URL = "https://myteamw.github.io/stock-picker/"


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


def is_valid_date(value: str) -> bool:
  if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
    return False
  try:
    parsed = datetime.fromisoformat(value)
  except ValueError:
    return False
  return 2000 <= parsed.year <= 2100


def candidate_line(stock: dict[str, Any], index: int, settings: dict[str, Any]) -> str:
  base_position = base_position_for(stock, settings) or "未填写"
  return (
    f"{index}. {useful_stock_name(stock.get('name'), stock.get('code'))}（{stock.get('code')}）："
    f"现价{money(stock.get('price'))}元，涨跌幅{percent(stock.get('change_percent'))}，"
    f"今高/今低{money(stock.get('high'))}/{money(stock.get('low'))}，"
    f"开盘/昨收{money(stock.get('open'))}/{money(stock.get('previous_close'))}，"
    f"底仓情况：{base_position}，备注："
    f"{stock.get('remark') or stock.get('business') or '无'}"
  )


def build_default_prompt(settings: dict[str, Any], ranked: list[tuple[float, dict[str, Any]]], stocks: list[dict[str, Any]]) -> str:
  selected = ranked[0][1] if ranked else None
  selected_text = f"{useful_stock_name(selected.get('name'), selected.get('code'))}（{selected.get('code')}）" if selected else "暂无"
  candidate_source = [stock for _, stock in ranked[:8]] or stocks[:8]
  candidates = "\n".join(candidate_line(stock, index, settings) for index, stock in enumerate(candidate_source, 1))
  if not candidates:
    candidates = "暂无可用股票。"

  return (
    "请你作为谨慎的 A 股短线选股助手，只根据本页面股票池、底仓情况、备注和今日行情，"
    "推荐 1 只今日买入观察标的。请综合价格区间、涨跌幅、日内高低点、开盘/昨收、"
    "底仓情况和备注判断，不要机械照搬页面本地预选。\n\n"
    f"我的设置：价格区间 {money(settings.get('minPrice'))} - {money(settings.get('maxPrice'))} 元；"
    f"默认选股时间 {settings.get('pickTime') or '14:30'}；计划买入 {int(settings.get('lot') or 1)} 手"
    f"（{int(settings.get('lot') or 1) * 100} 股）。\n\n"
    f"页面本地预选候选：{selected_text}。这只是页面根据当前行情整理出的阅读顺序，不代表最终结论。\n\n"
    f"股票列表：\n{candidates}"
    "\n\n请输出：推荐股票、推荐理由、需要回避的风险、买入量提醒、理想买点、止损位、"
    "短线目标区间，并明确不构成投资建议。"
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
    "title": "必填，展示标题，例如 今日观察候选：某某（000000）",
    "summary": "必填，1-2 句概括分析结论，需写明不构成投资建议",
    "rationale": "必填，字符串数组，列出选择依据",
    "risks": "必填，字符串数组，列出主要风险和放弃条件",
    "action": "必填，操作建议文本，包含不追高、理想买点、止损、目标、买入量提醒",
    "prompt": "可选，通常留空；页面默认提示词由 picker_settings.defaultPrompt 管理",
    "candidate_code": "可选，6 位股票代码；没有候选时为 null",
    "candidate_name": "可选，股票简称；没有候选时为 null",
    "source_count": "可选，本次读取的股票数量",
  }


def main() -> None:
  refresh_quotes = "--refresh-quotes" in sys.argv
  rows = supabase(f"{STOCK_TABLE}?select=*&deleted=eq.false&order=created_at.desc,code.asc")
  if not isinstance(rows, list):
    raise RuntimeError("stock query did not return a list")

  quote_errors: list[str] = []
  stocks = rows
  if refresh_quotes:
    stocks, quote_errors = refresh_stocks(rows)

  settings = load_settings()
  settings["pickTime"] = "14:30"
  ranked = sorted(
    [(score_stock(stock, settings), stock) for stock in stocks],
    key=lambda item: item[0],
    reverse=True,
  )
  ranked = [(score, stock) for score, stock in ranked if score > 0]
  default_prompt = build_default_prompt(settings, ranked, stocks)
  persist_default_prompt(settings, default_prompt)
  settings["defaultPrompt"] = default_prompt
  user_requirements = str(settings.get("userRequirements") or "")
  combined_prompt = build_combined_prompt(default_prompt, user_requirements)

  context = {
    "trade_date": now_china().date().isoformat(),
    "generated_at": now_china().isoformat(),
    "page_url": PAGE_URL,
    "source_tables": {
      "stocks": STOCK_TABLE,
      "results": RESULT_TABLE,
    },
    "settings": settings,
    "stocks": [normalize_stock(stock, settings) for stock in stocks],
    "ranked_candidates": [
      {"score": round(score, 2), **normalize_stock(stock, settings)} for score, stock in ranked[:12]
    ],
    "quote_errors": quote_errors[:20],
    "default_prompt": default_prompt,
    "user_requirements": user_requirements,
    "combined_prompt": combined_prompt,
    "page_prompt": combined_prompt,
    "write_result_schema": build_writer_schema(),
    "next_step": (
      "Use default_prompt, user_requirements, stocks, ranked_candidates, and refreshed quote data to reason in Codex, then pass only the final result JSON "
      "to scripts/write_codex_result.py. Do not use GitHub Actions for the daily analysis."
    ),
  }
  print(json.dumps(context, ensure_ascii=False, indent=2))


if __name__ == "__main__":
  main()
