# Codex 定时自动化

这个仓库不使用 GitHub Actions 做每日选股分析。GitHub Pages 只托管前端；Codex 的定时自动化对话负责读取股票池、分析、写回结果。

## 每日流程

1. 在交易日 14:30 左右运行：

   ```powershell
   python scripts\read_codex_context.py --refresh-quotes
   ```

2. 脚本会先刷新页面默认提示词，并把 `default_prompt` 写回 `picker_settings.defaultPrompt`。Codex 根据输出里的 `default_prompt`、`user_requirements`、`big_pool_stocks`、`big_pool_ranked_candidates`、`holding_stocks` 和当天行情自行分析，不直接照搬规则分数。

3. Codex 生成两段结果 JSON：`buy_recommendation` 对应今日新买推荐，`holding_advice` 对应已持仓股票的操作建议，然后写入 Supabase：

   ```powershell
   python scripts\write_codex_result.py result.json
   ```

4. 页面 `https://myteamw.github.io/stock-picker/` 会读取 `picker_results` 最新 active 结果，并分别显示到“今日选股推荐”和“持仓操作建议”。

## Codex 自动化提示词建议

```text
每个交易日 14:30 执行。进入 F:\Codes\Stock_Tracker\stock-picker-live。
先运行 python scripts\read_codex_context.py --refresh-quotes 读取大池子（https://myteamw.github.io/tracker/）背后的 stocks 表、持仓 picker_stocks、默认提示词和“我的要求”。
你自己综合默认提示词、我的要求、大池行情、持仓底仓明细和页面其它信息做谨慎的 A 股分析，不要触发 GitHub Actions。
分析后生成符合 write_result_schema 的 JSON：buy_recommendation 从大池中推荐 1 只今日买入观察标的；holding_advice 只对底仓明细非空的持仓股给后续操作建议。然后运行 python scripts\write_codex_result.py result.json 写入 picker_results。
结果必须包含新买候选股票、理由、风险、买入量提醒、理想买点、止损、目标区间；持仓建议需明确持有、减仓、观察或止损条件，并写明不构成投资建议。
```

`scripts/run_picker_automation.py` 只保留为排序参考和本地备用工具，不作为每日推荐的“脑子”。
