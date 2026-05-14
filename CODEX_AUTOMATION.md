# Codex 定时自动化

这个仓库不使用 GitHub Actions 做每日选股分析。GitHub Pages 只托管前端；Codex 的定时自动化对话负责读取股票池、分析、写回结果。

## 每日流程

1. 在交易日 14:30 左右运行：

   ```powershell
   python scripts\read_codex_context.py --refresh-quotes
   ```

2. Codex 根据输出里的 `page_prompt`、`stocks`、`ranked_candidates` 和当天行情自行分析，不直接照搬规则分数。

3. Codex 生成结果 JSON，然后写入 Supabase：

   ```powershell
   python scripts\write_codex_result.py result.json
   ```

4. 页面 `https://myteamw.github.io/stock-picker/` 会读取 `picker_results` 最新 active 结果并显示到“选股结果”。

## Codex 自动化提示词建议

```text
每个交易日 14:30 执行。进入 F:\Codes\Stock_Tracker\stock-picker-live。
先运行 python scripts\read_codex_context.py --refresh-quotes 读取 stock-picker 页面对应的 Supabase 股票池和页面提示词。
你自己做谨慎的 A 股分析，不要使用 tracker 数据库，不要触发 GitHub Actions。
分析后生成符合 write_result_schema 的 JSON，并运行 python scripts\write_codex_result.py result.json 写入 picker_results。
结果必须包含候选股票、理由、风险、买入量提醒、理想买点、止损、目标区间，并写明不构成投资建议。
```

`scripts/run_picker_automation.py` 只保留为规则预筛和本地备用工具，不作为每日推荐的“脑子”。
