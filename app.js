const STORAGE_KEY = "myteamw-stock-picker-v1";
const SETTINGS_KEY = "myteamw-stock-picker-settings-v1";
const SUPABASE_URL = "https://kawztespuaiztftoifdk.supabase.co";
const SUPABASE_KEY = "sb_publishable_Ydf2JJK06d4GMTE2awOSwg_3GZLTR27";
const STOCK_TABLE = "picker_stocks";
const SETTINGS_TABLE = "picker_settings";
const RESULT_TABLE = "picker_results";
const SETTINGS_ROW_KEY = "default";

const DEFAULT_SETTINGS = {
  minPrice: 0,
  maxPrice: 70,
  pickTime: "14:30",
  lot: 1,
  defaultPrompt: "",
  userRequirements: "",
  basePositions: {},
};

const EMPTY_PICK_TEXT = "暂无 Codex 自动化选股结果。定时对话写入结果后这里会自动显示。";

const state = {
  stocks: [],
  settings: { ...DEFAULT_SETTINGS },
  editingCode: "",
  automationResult: null,
  remoteReady: false,
};

let settingsSyncTimer = null;

const els = {
  clock: document.querySelector("#clockText"),
  status: document.querySelector("#updateStatus"),
  refresh: document.querySelector("#refreshButton"),
  form: document.querySelector("#stockForm"),
  code: document.querySelector("#codeInput"),
  name: document.querySelector("#nameInput"),
  remark: document.querySelector("#remarkInput"),
  saveStock: document.querySelector("#saveStockButton"),
  clearForm: document.querySelector("#clearFormButton"),
  settingsForm: document.querySelector("#settingsForm"),
  minPrice: document.querySelector("#minPriceInput"),
  maxPrice: document.querySelector("#maxPriceInput"),
  lot: document.querySelector("#lotInput"),
  settingSummary: document.querySelector("#settingSummary"),
  pickResult: document.querySelector("#pickResult"),
  defaultPrompt: document.querySelector("#defaultPromptOutput"),
  userRequirements: document.querySelector("#userRequirementsInput"),
  refreshDefaultPrompt: document.querySelector("#refreshDefaultPromptButton"),
  rows: document.querySelector("#stockRows"),
  template: document.querySelector("#rowTemplate"),
  empty: document.querySelector("#emptyState"),
};

function normalizeCode(code) {
  return String(code || "").replace(/\D/g, "").slice(0, 6);
}

function isCode(value) {
  return /^\d{6}$/.test(normalizeCode(value));
}

function exchangePrefix(code) {
  return /^6|^9/.test(code) ? "1" : "0";
}

function secid(code) {
  return `${exchangePrefix(code)}.${normalizeCode(code)}`;
}

function secuCode(code) {
  const cleanCode = normalizeCode(code);
  if (/^6|^9/.test(cleanCode)) return `${cleanCode}.SH`;
  if (/^4|^8/.test(cleanCode)) return `${cleanCode}.BJ`;
  return `${cleanCode}.SZ`;
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function chinaNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
}

function money(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(2) : "-";
}

function percent(value) {
  const num = normalizePercentValue(value);
  return Number.isFinite(num) ? `${num.toFixed(2)}%` : "-";
}

function normalizePercentValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.abs(num) > 30 ? num / 100 : num;
}

function compactMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "-";
  if (num >= 100000000) return `${(num / 100000000).toFixed(2)}亿`;
  if (num >= 10000) return `${(num / 10000).toFixed(2)}万`;
  return num.toFixed(0);
}

function numberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function usefulStockName(name, code) {
  const text = String(name || "").trim();
  if (!text) return "";
  return normalizeCode(text) === normalizeCode(code) ? "" : text;
}

function displayStockName(stock) {
  return usefulStockName(stock && stock.name, stock && stock.code) || (stock && stock.code) || "";
}

function normalizeSettings(raw = {}) {
  const basePositions =
    raw && typeof raw.basePositions === "object" && !Array.isArray(raw.basePositions) ? raw.basePositions : {};
  const minPrice = Math.max(0, Number(raw.minPrice ?? DEFAULT_SETTINGS.minPrice) || DEFAULT_SETTINGS.minPrice);
  const maxPrice = Math.max(minPrice, Number(raw.maxPrice ?? DEFAULT_SETTINGS.maxPrice) || DEFAULT_SETTINGS.maxPrice);
  const lot = Math.max(1, Math.floor(Number(raw.lot ?? DEFAULT_SETTINGS.lot) || DEFAULT_SETTINGS.lot));
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    minPrice,
    maxPrice,
    pickTime: DEFAULT_SETTINGS.pickTime,
    lot,
    defaultPrompt: String(raw.defaultPrompt || ""),
    userRequirements: String(raw.userRequirements || ""),
    basePositions: { ...basePositions },
  };
}

function basePositionFor(code) {
  return String((state.settings.basePositions || {})[normalizeCode(code)] || "").trim();
}

function attachBasePositions(stocks) {
  return stocks.map((stock) => ({
    ...stock,
    basePosition: basePositionFor(stock.code) || stock.basePosition || "",
  }));
}

function quotePrice(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num / 100 : null;
}

function quoteSigned(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num / 100 : null;
}

function quoteTimestamp(value) {
  const raw = String(value || "");
  if (/^\d{14}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (/^\d{13}$/.test(raw) || /^\d{10}$/.test(raw)) {
    const ms = Number(raw) * (raw.length === 13 ? 1 : 1000);
    const chinaDate = new Date(new Date(ms).toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
    return formatDate(chinaDate);
  }
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return formatDate(new Date());
}

function normalizeDateText(value, fallback = "") {
  const raw = String(value || "");
  if (isValidDateText(raw)) return raw;
  const fallbackText = String(fallback || "");
  const fallbackDate = fallbackText.slice(0, 10);
  if (isValidDateText(fallbackDate)) return fallbackDate;
  return raw;
}

function isValidDateText(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00`);
  return date.getFullYear() >= 2000 && date.getFullYear() <= 2100 && !Number.isNaN(date.getTime());
}

function setStatus(text) {
  els.status.textContent = text;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderTextList(title, values) {
  const items = Array.isArray(values) ? values.filter(Boolean) : [];
  if (items.length === 0) return "";
  return `<div class="result-line"><strong>${escapeHtml(title)}：</strong>${items.map(escapeHtml).join("；")}</div>`;
}

function loadLocalState() {
  try {
    state.stocks = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    state.stocks = [];
  }

  try {
    state.settings = normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"));
  } catch {
    state.settings = normalizeSettings();
  }
  state.stocks = attachBasePositions(state.stocks);
}

function saveStocks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.stocks));
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: supabaseHeaders(options.headers),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Supabase HTTP ${response.status}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function fromDb(row) {
  const asNumber = (value) => (value === null || value === undefined ? null : Number(value));
  const closePrice = asNumber(row.close_price ?? row.price);
  const startPrice = asNumber(row.start_price);
  const highPrice = asNumber(row.high_price ?? row.high);
  const changeAmount =
    Number.isFinite(closePrice) && Number.isFinite(startPrice) ? closePrice - startPrice : asNumber(row.change_amount);
  const changePercent =
    Number.isFinite(closePrice) && Number.isFinite(startPrice) && startPrice > 0
      ? ((closePrice - startPrice) / startPrice) * 100
      : normalizePercentValue(row.change_percent);
  return {
    code: row.code,
    name: usefulStockName(row.name, row.code) || row.code,
    remark: row.remark || "",
    business: row.business || "",
    basePosition: "",
    startDate: row.start_date || "",
    startPrice,
    price: closePrice,
    high: highPrice,
    low: asNumber(row.low),
    open: asNumber(row.open),
    previousClose: asNumber(row.previous_close),
    changeAmount,
    changePercent,
    volume: asNumber(row.volume),
    turnover: asNumber(row.turnover),
    updatedAt: normalizeDateText(row.last_quote_date || row.quote_date, row.refreshed_at),
    refreshedAt: row.refreshed_at || "",
    createdAt: row.created_at || "",
    deleted: Boolean(row.deleted),
  };
}

function toDb(stock) {
  return {
    code: stock.code,
    name: displayStockName(stock) || stock.code,
    remark: stock.remark || "",
    business: stock.business || "",
    price: numberOrNull(stock.price),
    high: numberOrNull(stock.high),
    low: numberOrNull(stock.low),
    open: numberOrNull(stock.open),
    previous_close: numberOrNull(stock.previousClose),
    change_amount: numberOrNull(stock.changeAmount),
    change_percent: normalizePercentValue(stock.changePercent),
    volume: numberOrNull(stock.volume),
    turnover: numberOrNull(stock.turnover),
    quote_date: stock.updatedAt || null,
    refreshed_at: stock.refreshedAt || null,
    deleted: Boolean(stock.deleted),
  };
}

function fromResultDb(row) {
  return {
    active: row.active !== false,
    generatedAt: row.generated_at || row.created_at || "",
    title: row.title || "自动化选股结果",
    summary: row.summary || "",
    rationale: Array.isArray(row.rationale) ? row.rationale : [],
    risks: Array.isArray(row.risks) ? row.risks : [],
    action: row.action || "",
    prompt: row.prompt || "",
  };
}

async function loadRemoteState() {
  const cachedStocks = [...state.stocks];
  const cachedSettings = { ...state.settings };
  const stocks = await supabaseRequest(`${STOCK_TABLE}?select=*&deleted=eq.false&order=created_at.desc,code.asc`);

  state.stocks = Array.isArray(stocks) && stocks.length > 0 ? stocks.map(fromDb) : cachedStocks;
  try {
    const settingsRows = await supabaseRequest(`${SETTINGS_TABLE}?select=value&key=eq.${SETTINGS_ROW_KEY}&limit=1`);
    if (Array.isArray(settingsRows) && settingsRows[0] && settingsRows[0].value) {
      state.settings = normalizeSettings(settingsRows[0].value);
    } else {
      state.settings = normalizeSettings(cachedSettings);
    }
  } catch {
    state.settings = normalizeSettings(cachedSettings);
  }
  state.stocks = attachBasePositions(state.stocks);
  saveStocks();
  saveSettings();
}

async function initRemoteState() {
  try {
    await loadRemoteState();
    state.remoteReady = true;
    fillSettingsForm();
    render();
    setStatus("在线数据库已连接");
    await repairMissingStockNames();
  } catch {
    state.remoteReady = false;
    setStatus("在线数据库未就绪，正在使用本地缓存");
  }
}

async function upsertRemoteStock(stock) {
  if (!state.remoteReady) return false;
  try {
    const rows = await supabaseRequest(`${STOCK_TABLE}?on_conflict=code`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(toDb(stock)),
    });
    if (Array.isArray(rows) && rows[0]) {
      const saved = fromDb(rows[0]);
      state.stocks = [saved, ...state.stocks.filter((item) => item.code !== saved.code)];
      saveStocks();
      render();
    }
    return true;
  } catch {
    state.remoteReady = false;
    setStatus("在线数据库写入失败，已保存在本地缓存");
    return false;
  }
}

async function patchRemoteStock(code, patch) {
  if (!state.remoteReady) return false;
  try {
    await supabaseRequest(`${STOCK_TABLE}?code=eq.${encodeURIComponent(code)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(patch),
    });
    return true;
  } catch {
    state.remoteReady = false;
    setStatus("在线数据库更新失败，已保存在本地缓存");
    return false;
  }
}

async function upsertRemoteSettings() {
  if (!state.remoteReady) return false;
  try {
    await supabaseRequest(`${SETTINGS_TABLE}?on_conflict=key`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        key: SETTINGS_ROW_KEY,
        value: {
          minPrice: state.settings.minPrice,
          maxPrice: state.settings.maxPrice,
          pickTime: DEFAULT_SETTINGS.pickTime,
          lot: state.settings.lot,
          defaultPrompt: state.settings.defaultPrompt || "",
          userRequirements: state.settings.userRequirements || "",
          basePositions: state.settings.basePositions || {},
        },
      }),
  });
    return true;
  } catch {
    return false;
  }
}

function jsonp(url, callbackParam = "cb") {
  return new Promise((resolve, reject) => {
    const callback = `stockPicker_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("请求超时"));
    }, 12000);

    function cleanup() {
      window.clearTimeout(timeout);
      script.remove();
      delete window[callback];
    }

    window[callback] = (payload) => {
      cleanup();
      resolve(payload);
    };

    script.src = `${url}${url.includes("?") ? "&" : "?"}${callbackParam}=${callback}`;
    script.onerror = () => {
      cleanup();
      reject(new Error("行情请求失败"));
    };
    document.body.appendChild(script);
  });
}

async function resolveStockByName(name) {
  const url = new URL("https://searchapi.eastmoney.com/api/suggest/get");
  url.searchParams.set("input", name);
  url.searchParams.set("type", "14");
  url.searchParams.set("token", "D43BF722C8E33FCD6DC17E80F5BDF918");
  const payload = await jsonp(url.toString());
  const rows = payload && payload.QuotationCodeTable && payload.QuotationCodeTable.Data;
  const match = Array.isArray(rows) && rows.find((row) => row.Classify === "AStock" && /^\d{6}$/.test(row.Code));
  if (!match) throw new Error(`未找到股票：${name}`);
  return { code: normalizeCode(match.Code), name: match.Name || name };
}

function summarizeBusiness(text) {
  const clean = String(text || "")
    .replace(/等.*$/u, "")
    .replace(/主要从事|主营业务为|公司主营业务为|业务包括|产品包括|提供|基于|为客户/gu, "")
    .trim();
  return clean
    .split(/[、，,；;及和]/u)
    .map((part) => part.replace(/.*的/u, "").replace(/(研发|生产|销售|服务|运营|制造)$/u, "").trim())
    .filter(Boolean)
    .slice(0, 4)
    .join("、");
}

async function fetchProfile(code) {
  const url = new URL("https://datacenter.eastmoney.com/securities/api/data/v1/get");
  url.searchParams.set("reportName", "RPT_F10_ORG_BASICINFO");
  url.searchParams.set("columns", "SECUCODE,SECURITY_NAME_ABBR,MAIN_BUSINESS,PRODUCT_NAME,EM2016");
  url.searchParams.set("filter", `(SECUCODE="${secuCode(code)}")`);
  url.searchParams.set("pageNumber", "1");
  url.searchParams.set("pageSize", "1");
  url.searchParams.set("source", "HSF10");
  url.searchParams.set("client", "PC");

  try {
    const payload = await jsonp(url.toString(), "callback");
    const row = payload && payload.result && payload.result.data && payload.result.data[0];
    if (!row) return { name: "", business: "" };
    return {
      name: row.SECURITY_NAME_ABBR || "",
      business: summarizeBusiness(row.MAIN_BUSINESS || row.PRODUCT_NAME || row.EM2016),
    };
  } catch {
    return { name: "", business: "" };
  }
}

async function fetchQuote(code) {
  const url = new URL("https://push2.eastmoney.com/api/qt/stock/get");
  url.searchParams.set("secid", secid(code));
  url.searchParams.set("fields", "f43,f44,f45,f46,f47,f48,f57,f58,f60,f86,f169,f170");
  let payload;
  try {
    const response = await fetch(url.toString(), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = await response.json();
  } catch {
    payload = await jsonp(url.toString(), "cb");
  }
  const data = payload && payload.data;
  if (!data || !data.f57) throw new Error(`未找到行情：${code}`);
  return {
    code: normalizeCode(data.f57 || code),
    name: data.f58 || "",
    price: quotePrice(data.f43),
    high: quotePrice(data.f44),
    low: quotePrice(data.f45),
    open: quotePrice(data.f46),
    previousClose: quotePrice(data.f60),
    changeAmount: quoteSigned(data.f169),
    changePercent: quoteSigned(data.f170),
    volume: numberOrNull(data.f47),
    turnover: numberOrNull(data.f48),
    updatedAt: quoteTimestamp(data.f86),
    refreshedAt: new Date().toISOString(),
  };
}

async function hydrateStock(entry) {
  const quote = await fetchQuote(entry.code);
  const profile = await fetchProfile(entry.code);
  const entryName = usefulStockName(entry.name, entry.code);
  const quoteName = usefulStockName(quote.name, quote.code);
  const profileName = usefulStockName(profile.name, entry.code);
  return {
    ...entry,
    ...quote,
    name: entryName || quoteName || profileName || entry.code,
    business: profile.business || entry.business || "",
    basePosition: entry.basePosition || basePositionFor(entry.code),
    remark: entry.remark || "",
    createdAt: entry.createdAt || new Date().toISOString(),
  };
}

function manualStock(entry) {
  return {
    ...entry,
    name: usefulStockName(entry.name, entry.code) || entry.code,
    price: null,
    high: null,
    low: null,
    open: null,
    previousClose: null,
    changeAmount: null,
    changePercent: null,
    volume: null,
    turnover: null,
    updatedAt: "",
    refreshedAt: new Date().toISOString(),
    business: entry.business || "",
    basePosition: entry.basePosition || basePositionFor(entry.code),
    remark: entry.remark || "",
    createdAt: entry.createdAt || new Date().toISOString(),
  };
}

function fillSettingsForm() {
  els.minPrice.value = state.settings.minPrice;
  els.maxPrice.value = state.settings.maxPrice;
  els.lot.value = state.settings.lot;
}

function updateClock() {
  els.clock.textContent = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function priceFits(stock) {
  const price = Number(stock.price);
  const min = Number(state.settings.minPrice);
  const max = Number(state.settings.maxPrice);
  return Number.isFinite(price) && price >= min && price <= max;
}

function filteredStocks() {
  return state.stocks;
}

function setTrend(cell, value) {
  cell.textContent = percent(value);
  cell.classList.toggle("positive", Number(value) > 0);
  cell.classList.toggle("negative", Number(value) < 0);
}

function renderSummary() {
  const eligible = state.stocks.filter(priceFits).length;
  const lotShares = Number(state.settings.lot) * 100;
  els.settingSummary.textContent = `价格区间：${money(state.settings.minPrice)} - ${money(state.settings.maxPrice)} 元；默认时间：${DEFAULT_SETTINGS.pickTime}；买入量：${state.settings.lot} 手（${lotShares} 股）；符合区间：${eligible} 只`;
}

function buildCandidateLine(stock, index) {
  const displayIndex = Number(index) + 1;
  const basePosition = stock.basePosition || basePositionFor(stock.code) || "未填写";
  const remark = stock.remark || stock.business || "无";
  return `${displayIndex}. ${displayStockName(stock)}（${stock.code}）：现价 ${money(stock.price)} 元，涨跌幅 ${percent(
    stock.changePercent,
  )}，今高/今低 ${money(stock.high)}/${money(stock.low)}，开盘/昨收 ${money(stock.open)}/${money(
    stock.previousClose,
  )}，底仓情况：${basePosition}，备注：${remark}`;
}

function buildDefaultPrompt() {
  const ranked = eligibleStocks();
  const visibleStocks = ranked.length > 0 ? ranked : [...state.stocks];
  const selectedStock = visibleStocks[0] || null;
  const candidateText = visibleStocks.slice(0, 8).map(buildCandidateLine).join("\n") || "暂无可用股票。";
  const selectedText = selectedStock ? `${displayStockName(selectedStock)}（${selectedStock.code}）` : "暂无";
  const lotShares = Number(state.settings.lot) * 100;

  return [
    "请你作为谨慎的 A 股短线选股助手，只根据本页面股票池、底仓情况、备注和今日行情，推荐 1 只今日买入观察标的。",
    "请综合价格区间、涨跌幅、日内高低点、开盘/昨收、底仓情况和备注判断，不要机械照搬页面本地预选。",
    `我的设置：价格区间 ${money(state.settings.minPrice)} - ${money(
      state.settings.maxPrice,
    )} 元；默认选股时间 ${DEFAULT_SETTINGS.pickTime}；计划买入 ${state.settings.lot} 手（${lotShares} 股）。`,
    `页面本地预选候选：${selectedText}。这只是页面根据当前行情整理出的阅读顺序，不代表最终结论。`,
    `股票池：\n${candidateText}`,
    "请输出：推荐股票、推荐理由、需要回避的风险、买入量提醒、理想买点、止损位、短线目标区间，并明确不构成投资建议。",
  ].join("\n\n");
}

function currentDefaultPrompt() {
  return state.settings.defaultPrompt || buildDefaultPrompt();
}

function renderPromptInputs() {
  els.defaultPrompt.value = currentDefaultPrompt();
  els.userRequirements.value = state.settings.userRequirements || "";
}

function renderPickResult() {
  if (state.automationResult) {
    const result = state.automationResult;
    const title = result.title || "自动化选股结果";
    const summary = result.summary || "";
    const generatedAt = result.generatedAt ? ` <span class="muted">生成时间：${escapeHtml(result.generatedAt)}</span>` : "";
    els.pickResult.innerHTML = `
      <div class="result-title"><strong>${escapeHtml(title)}</strong>${generatedAt}</div>
      ${summary ? `<div class="result-line">${escapeHtml(summary)}</div>` : ""}
      ${renderTextList("依据", result.rationale)}
      ${renderTextList("风险", result.risks)}
      ${
        result.action
          ? `<div class="result-line"><strong>短线操作：</strong><span class="result-emphasis">${escapeHtml(
              result.action,
            )}</span></div>`
          : ""
      }
    `;
    return;
  }

  els.pickResult.textContent = EMPTY_PICK_TEXT;
}

function render() {
  els.rows.textContent = "";
  const stocks = filteredStocks();
  els.empty.hidden = stocks.length > 0;
  renderSummary();
  renderPromptInputs();

  for (const stock of stocks) {
    const row = els.template.content.firstElementChild.cloneNode(true);
    const cells = Object.fromEntries([...row.querySelectorAll("[data-key]")].map((cell) => [cell.dataset.key, cell]));

    cells.identity.textContent = "";
    const nameLine = document.createElement("a");
    const codeLine = document.createElement("div");
    nameLine.className = "stock-name";
    nameLine.href = `https://stockpage.10jqka.com.cn/${stock.code}/`;
    nameLine.target = "_blank";
    nameLine.rel = "noopener noreferrer";
    nameLine.textContent = displayStockName(stock);
    codeLine.className = "stock-code";
    codeLine.textContent = `（${stock.code}）`;
    cells.identity.append(nameLine, codeLine);

    cells.price.textContent = money(stock.price);
    setTrend(cells.change, stock.changePercent);
    cells.range.textContent = `${money(stock.high)} / ${money(stock.low)}`;
    const baseInput = document.createElement("textarea");
    baseInput.className = "base-position-input";
    baseInput.rows = 2;
    baseInput.placeholder = "无 / 1手 / 成本39.20";
    baseInput.value = stock.basePosition || basePositionFor(stock.code);
    baseInput.addEventListener("change", () => saveBasePosition(stock.code, baseInput.value));
    cells.basePosition.appendChild(baseInput);
    cells.remark.textContent = stock.remark || stock.business || "-";
    cells.updatedAt.textContent = stock.updatedAt || "-";

    row.querySelector(".edit").addEventListener("click", () => editStock(stock.code));
    row.querySelector(".delete").addEventListener("click", () => deleteStock(stock.code));
    els.rows.appendChild(row);
  }

  renderPickResult();
}

async function loadAutomationResult() {
  try {
    const rows = await supabaseRequest(`${RESULT_TABLE}?select=*&active=eq.true&order=generated_at.desc&limit=1`);
    if (Array.isArray(rows) && rows[0]) {
      state.automationResult = fromResultDb(rows[0]);
      renderPickResult();
      setStatus("已加载自动化选股结果");
      return;
    }
  } catch {
    setStatus("自动化结果表未就绪");
  }
}

function clearForm() {
  state.editingCode = "";
  els.form.reset();
  els.saveStock.textContent = "添加股票";
  els.code.disabled = false;
}

function editStock(code) {
  const stock = state.stocks.find((item) => item.code === code);
  if (!stock) return;
  state.editingCode = code;
  els.code.value = stock.code;
  els.name.value = stock.name || "";
  els.remark.value = stock.remark || "";
  els.code.disabled = true;
  els.saveStock.textContent = "保存修改";
  setStatus(`正在编辑 ${displayStockName(stock)}`);
}

async function deleteStock(code) {
  const stock = state.stocks.find((item) => item.code === code);
  state.stocks = state.stocks.filter((item) => item.code !== code);
  if (state.settings.basePositions && state.settings.basePositions[code]) {
    delete state.settings.basePositions[code];
    saveSettings();
  }
  saveStocks();
  clearForm();
  render();
  setStatus(`${stock ? displayStockName(stock) : code} 已删除，正在同步`);
  await patchRemoteStock(code, { deleted: true });
  await upsertRemoteSettings();
  setStatus(`${stock ? displayStockName(stock) : code} 已删除`);
}

async function upsertStockFromForm(event) {
  event.preventDefault();
  const rawCode = normalizeCode(els.code.value);
  const rawName = els.name.value.trim();
  const remark = els.remark.value.trim();

  try {
    if (state.editingCode) {
      const editCode = state.editingCode;
      state.stocks = state.stocks.map((stock) =>
        stock.code === editCode ? { ...stock, name: usefulStockName(rawName, editCode) || stock.name, remark } : stock,
      );
      saveStocks();
      clearForm();
      render();
      setStatus("股票信息已保存，正在同步");
      const saved = state.stocks.find((stock) => stock.code === editCode);
      if (saved) await upsertRemoteStock(saved);
      setStatus("股票信息已保存");
      return;
    }

    let entry = {};
    if (isCode(rawCode)) entry = { code: rawCode, name: rawName };
    else if (rawName) entry = await resolveStockByName(rawName);
    else {
      setStatus("请输入股票代码或股票名称");
      return;
    }

    setStatus(`正在添加 ${entry.name || entry.code}`);
    let hydrated;
    try {
      hydrated = await hydrateStock({ ...entry, remark });
    } catch {
      hydrated = manualStock({ ...entry, remark });
    }
    state.stocks = [hydrated, ...state.stocks.filter((stock) => stock.code !== hydrated.code)];
    state.stocks = attachBasePositions(state.stocks);
    saveStocks();
    clearForm();
    render();
    setStatus(`${displayStockName(hydrated)} 已添加，正在同步`);
    await upsertRemoteStock(hydrated);
    setStatus(`${displayStockName(hydrated)} 已添加`);
  } catch (error) {
    setStatus(error.message || "添加失败");
  }
}

async function refreshStocks() {
  if (state.stocks.length === 0) {
    setStatus("暂无股票可刷新");
    return;
  }

  setStatus("正在刷新行情");
  const refreshed = [];
  for (const stock of state.stocks) {
    try {
      refreshed.push(await hydrateStock(stock));
    } catch {
      refreshed.push(stock);
    }
  }
  state.stocks = attachBasePositions(refreshed);
  saveStocks();
  state.settings.defaultPrompt = buildDefaultPrompt();
  saveSettings();
  render();
  setStatus(`已刷新 ${state.stocks.length} 只股票，正在同步`);
  for (const stock of state.stocks) {
    await upsertRemoteStock(stock);
  }
  await upsertRemoteSettings();
  setStatus(`已刷新 ${state.stocks.length} 只股票`);
}

async function repairMissingStockNames() {
  if (!state.stocks.some((stock) => !usefulStockName(stock.name, stock.code))) return;

  setStatus("正在补全股票名称");
  let changed = false;
  const repaired = [];
  for (const stock of state.stocks) {
    if (usefulStockName(stock.name, stock.code)) {
      repaired.push(stock);
      continue;
    }
    try {
      const hydrated = await hydrateStock(stock);
      changed = changed || Boolean(usefulStockName(hydrated.name, hydrated.code));
      repaired.push(hydrated);
    } catch {
      repaired.push(stock);
    }
  }

  if (!changed) {
    setStatus("股票名称待刷新");
    return;
  }

  state.stocks = attachBasePositions(repaired);
  state.settings.defaultPrompt = buildDefaultPrompt();
  saveStocks();
  saveSettings();
  render();
  for (const stock of state.stocks) {
    if (usefulStockName(stock.name, stock.code)) await upsertRemoteStock(stock);
  }
  await upsertRemoteSettings();
  setStatus("股票名称已补全");
}

function scoreStock(stock) {
  const price = Number(stock.price);
  const change = normalizePercentValue(stock.changePercent);
  const high = Number(stock.high);
  const low = Number(stock.low);
  const turnover = Number(stock.turnover);
  if (!Number.isFinite(price) || !priceFits(stock)) return -999;

  let score = 0;
  score += price >= 6 && price <= 60 ? 18 : 8;
  if (Number.isFinite(change)) {
    if (change >= -1.5 && change <= 4.5) score += 28;
    else if (change > 4.5 && change <= 7.5) score += 18;
    else if (change >= -4 && change < -1.5) score += 12;
    else score += 4;
  } else {
    score += 8;
  }

  if (Number.isFinite(high) && Number.isFinite(low) && high > low) {
    const intradayPosition = (price - low) / (high - low);
    if (intradayPosition >= 0.35 && intradayPosition <= 0.78) score += 24;
    else if (intradayPosition < 0.35) score += 14;
    else score += 8;
  }

  if (Number.isFinite(turnover)) {
    if (turnover >= 500000000) score += 18;
    else if (turnover >= 100000000) score += 12;
    else if (turnover >= 30000000) score += 6;
  }

  const theme = `${stock.remark || ""} ${stock.business || ""}`;
  if (/通信|电力|新能源|半导体|智能|光|电子|材料|算力|AI/u.test(theme)) score += 10;
  if (/^(688|300|301)/.test(stock.code || "")) score -= 3;
  return score;
}

function eligibleStocks() {
  return state.stocks
    .filter(priceFits)
    .map((stock) => ({ ...stock, score: scoreStock(stock) }))
    .sort((a, b) => b.score - a.score);
}

function scheduleSettingsSync(successText = "页面信息已保存") {
  saveSettings();
  window.clearTimeout(settingsSyncTimer);
  settingsSyncTimer = window.setTimeout(async () => {
    const synced = await upsertRemoteSettings();
    if (synced) setStatus(successText);
  }, 700);
}

async function refreshDefaultPrompt() {
  state.settings.defaultPrompt = buildDefaultPrompt();
  saveSettings();
  renderPromptInputs();
  setStatus("默认提示词已刷新，正在同步");
  await upsertRemoteSettings();
  setStatus("默认提示词已刷新");
}

function saveUserRequirements() {
  state.settings.userRequirements = els.userRequirements.value.trim();
  scheduleSettingsSync("我的要求已保存");
}

function saveBasePosition(code, value) {
  const cleanCode = normalizeCode(code);
  const text = String(value || "").trim();
  state.settings.basePositions = { ...(state.settings.basePositions || {}) };
  if (text) {
    state.settings.basePositions[cleanCode] = text;
  } else {
    delete state.settings.basePositions[cleanCode];
  }
  state.stocks = state.stocks.map((stock) => (stock.code === cleanCode ? { ...stock, basePosition: text } : stock));
  state.settings.defaultPrompt = buildDefaultPrompt();
  saveStocks();
  renderPromptInputs();
  scheduleSettingsSync("底仓情况已保存");
}

async function saveSettingsFromForm(event) {
  event.preventDefault();
  const minPrice = Math.max(0, Number(els.minPrice.value) || 0);
  const maxPrice = Math.max(minPrice, Number(els.maxPrice.value) || DEFAULT_SETTINGS.maxPrice);
  const lot = Math.max(1, Math.floor(Number(els.lot.value) || DEFAULT_SETTINGS.lot));
  state.settings = {
    ...state.settings,
    minPrice,
    maxPrice,
    pickTime: DEFAULT_SETTINGS.pickTime,
    lot,
  };
  state.settings.defaultPrompt = buildDefaultPrompt();
  fillSettingsForm();
  saveSettings();
  render();
  setStatus("选股设置已保存，正在同步");
  await upsertRemoteSettings();
  setStatus("选股设置已保存");
}

els.form.addEventListener("submit", upsertStockFromForm);
els.clearForm.addEventListener("click", clearForm);
els.settingsForm.addEventListener("submit", saveSettingsFromForm);
els.refresh.addEventListener("click", refreshStocks);
els.refreshDefaultPrompt.addEventListener("click", refreshDefaultPrompt);
els.userRequirements.addEventListener("input", saveUserRequirements);

loadLocalState();
fillSettingsForm();
updateClock();
render();
initRemoteState();
loadAutomationResult();
window.setInterval(updateClock, 1000);
