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


def normalize_stock(stock: dict[str, Any]) -> dict[str, Any]:
  quote_date = str(stock.get("quote_date") or "")
  if not is_valid_date(quote_date):
    refreshed_at = str(stock.get("refreshed_at") or "")
    quote_date = refreshed_at[:10] if re.fullmatch(r"\d{4}-\d{2}-\d{2}.*", refreshed_at) else ""
  return {
    "code": stock.get("code"),
    "name": stock.get("name") or stock.get("code"),
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


def candidate_line(stock: dict[str, Any], index: int) -> str:
  return (
    f"{index}. {stock.get('name') or stock.get('code')}（{stock.get('code')}）："
    f"现价{money(stock.get('price'))}元，涨跌幅{percent(stock.get('change_percent'))}，"
    f"今高/今低{money(stock.get('high'))}/{money(stock.get('low'))}，"
    f"成交额{compact_money(stock.get('turnover'))}，备注："
    f"{stock.get('remark') or stock.get('business') or '无'}"
  )


def build_page_prompt(settings: dict[str, Any], ranked: list[tuple[float, dict[str, Any]]]) -> str:
  selected = ranked[0][1] if ranked else None
  selected_text = f"{selected.get('name') or selected.get('code')}（{selected.get('code')}）" if selected else "暂无"
  candidates = "\n".join(candidate_line(stock, index) for index, (_, stock) in enumerate(ranked[:8], 1))
  if not candidates:
    candidates = "暂无符合价格区间和可用行情的股票。"

  return (
    "请你作为谨慎的 A 股分析助手，基于我提供的列表，从符合价格区间的股票里选出 1 只"
    "“买入候选”，并说明理由和风险点。我在下午两点半左右给你的列表，请结合今日实时数据进行分析。"
    "输出请包含但不限于：候选股票、为什么符合、需要回避的风险、买入量提醒、买法"
    "（例如：不追高；理想买点、止损、目标区间）。\n\n"
    f"我的设置：价格区间 {money(settings.get('minPrice'))} - {money(settings.get('maxPrice'))} 元；"
    f"默认选股时间 {settings.get('pickTime') or '14:30'}；计划买入 {int(settings.get('lot') or 1)} 手"
    f"（{int(settings.get('lot') or 1) * 100} 股）。\n\n"
    f"规则预筛候选：{selected_text}。\n\n"
    f"候选列表：\n{candidates}"
  )


def build_writer_schema() -> dict[str, str]:
  return {
    "title": "必填，展示标题，例如 今日观察候选：某某（000000）",
    "summary": "必填，1-2 句概括分析结论，需写明不构成投资建议",
    "rationale": "必填，字符串数组，列出选择依据",
    "risks": "必填，字符串数组，列出主要风险和放弃条件",
    "action": "必填，操作建议文本，包含不追高、理想买点、止损、目标、买入量提醒",
    "prompt": "可选，写回页面提示词框的复核提示",
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

  context = {
    "trade_date": now_china().date().isoformat(),
    "generated_at": now_china().isoformat(),
    "page_url": PAGE_URL,
    "source_tables": {
      "stocks": STOCK_TABLE,
      "results": RESULT_TABLE,
    },
    "settings": settings,
    "stocks": [normalize_stock(stock) for stock in stocks],
    "ranked_candidates": [
      {"score": round(score, 2), **normalize_stock(stock)} for score, stock in ranked[:12]
    ],
    "quote_errors": quote_errors[:20],
    "page_prompt": build_page_prompt(settings, ranked),
    "write_result_schema": build_writer_schema(),
    "next_step": (
      "Use the page_prompt and stock data to reason in Codex, then pass only the final result JSON "
      "to scripts/write_codex_result.py. Do not use GitHub Actions for the daily analysis."
    ),
  }
  print(json.dumps(context, ensure_ascii=False, indent=2))


if __name__ == "__main__":
  main()
