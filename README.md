# 选股助手

一个纯静态的 A 股观察和选股辅助网页，设计风格沿用现有 tracker。

## 功能

- 持仓股票增删，优先同步到 Supabase 在线数据库，失败时保存在浏览器 localStorage。
- 通过公开行情接口刷新股票现价、涨跌幅、日内高低、成交额等基础信息。
- 今日选股默认按 `价格区间 0.00 - 70.00 元；计划买入 1 手（100 股）。` 作为“我的要求”，页面可手动修改。
- 页面分成两块：上半部分从大池子 `https://myteamw.github.io/tracker/` 给出今日新买推荐；下半部分对已填写底仓明细的持仓股给出后续操作建议。
- 添加持仓时录入股票代码/名称、买入量和买入价，页面会生成只读底仓明细，并把默认提示词和“我的要求”同步到 Supabase 设置。
- Codex 定时自动化默认在交易日 14:30 分析并写入两段结果。
- 无 OpenAI API 模式：网页不直接调用模型；Codex 定时对话负责综合默认提示词、我的要求和股票池行情后写回结果。

## 重要说明

个人 ChatGPT/Codex 订阅不能被网页里的静态 JS 直接调用。这个项目因此让 Codex 桌面端的定时自动化对话做分析，再把结果写入 Supabase；网页只读取结果，不会保存或传输你的 OpenAI 账号信息。

本工具只做信息整理和候选筛选，不构成投资建议。

## Supabase

先在 Supabase SQL Editor 运行 `supabase-schema.sql`。表建好后，网页会连接本项目自己的 `picker_stocks`、`picker_settings` 和 `picker_results`。今日新买推荐会只读大池子页面背后的 `stocks` 表，持仓建议仍以 `picker_stocks` 和 `picker_settings.basePositions` 为准。

## 自动化

本项目不使用 GitHub Actions 做每日分析。Codex 定时自动化对话才是分析和推荐的执行者。

定时对话的流程见 `CODEX_AUTOMATION.md`：

- `scripts/read_codex_context.py --refresh-quotes` 读取大池 `stocks`、持仓 `picker_stocks`、设置、默认提示词和“我的要求”，并先刷新默认提示词。
- Codex 结合当天行情、默认提示词、我的要求、大池数据和持仓底仓明细自行分析，不直接照搬规则分数。
- `scripts/write_codex_result.py result.json` 把结果写入 `picker_results`。

网页打开时会读取最新 `picker_results`，分别显示“今日选股推荐”和“持仓操作建议”，不需要每天提交 GitHub Pages 静态文件。
