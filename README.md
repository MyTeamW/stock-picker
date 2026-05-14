# 选股助手

一个纯静态的 A 股观察和选股辅助网页，设计风格沿用现有 tracker。

## 功能

- 股票增删改查，优先同步到 Supabase 在线数据库，失败时保存在浏览器 localStorage。
- 通过公开行情接口刷新股票现价、涨跌幅、日内高低、成交额等基础信息。
- 设置价格区间，默认人民币 70 元以内。
- Codex 定时自动化默认在交易日 14:30 分析并写入结果。
- 设置买入量，默认 1 手。
- 无 OpenAI API 模式：网页不直接调用模型；Codex 定时对话负责分析，也保留可复制提示词的手动备用方式。

## 重要说明

个人 ChatGPT/Codex 订阅不能被网页里的静态 JS 直接调用。这个项目因此让 Codex 桌面端的定时自动化对话做分析，再把结果写入 Supabase；网页只读取结果，不会保存或传输你的 OpenAI 账号信息。

本工具只做信息整理和候选筛选，不构成投资建议。

## Supabase

先在 Supabase SQL Editor 运行 `supabase-schema.sql`。表建好后，网页会只连接本项目自己的 `picker_stocks`、`picker_settings` 和 `picker_results`，不再读取 tracker 的 `stocks` 表。

## 自动化

本项目不使用 GitHub Actions 做每日分析。Codex 定时自动化对话才是分析和推荐的执行者。

定时对话的流程见 `CODEX_AUTOMATION.md`：

- `scripts/read_codex_context.py --refresh-quotes` 读取 `picker_stocks`、设置和页面提示词上下文。
- Codex 结合当天行情和提示词自行分析，不直接照搬规则分数。
- `scripts/write_codex_result.py result.json` 把结果写入 `picker_results`。

网页打开时会读取最新 `picker_results` 并显示在“选股结果”里，不需要每天提交 GitHub Pages 静态文件。
