const STORAGE_KEY = "myteamw-stock-picker-v1";
const SETTINGS_KEY = "myteamw-stock-picker-settings-v1";
const PICK_KEY = "myteamw-stock-picker-last-pick-v1";
const SUPABASE_URL = "https://kawztespuaiztftoifdk.supabase.co";
const SUPABASE_KEY = "sb_publishable_Ydf2JJK06d4GMTE2awOSwg_3GZLTR27";
const STOCK_TABLE = "picker_stocks";
const SETTINGS_TABLE = "picker_settings";
const SETTINGS_ROW_KEY = "default";

const DEFAULT_SETTINGS = {
  minPrice: 0,
  maxPrice: 70,
  pickTime: "14:35",
  lot: 1,
};

const EMPTY_PICK_TEXT = "暂无选股结果。到达默认时间后，页面打开时会自动生成一次候选；也可以点击“现在选股”。";

const state = {
  stocks: [],
  settings: { ...DEFAULT_SETTINGS },
  query: "",
  editingCode: "",
  lastPick: null,
  remoteReady: false,
};

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
  search: document.querySelector("#searchInput"),
  pickNow: document.querySelector("#pickNowButton"),
  pickResult: document.querySelector("#pickResult"),
  promptOutput: document.querySelector("#promptOutput"),
  copyPrompt: document.querySelector("#copyPromptButton"),
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
  const num = Number(value);
  return Number.isFinite(num) ? `${num.toFixed(2)}%` : "-";
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

function quotePrice(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num / 100 : null;
}

function quoteTimestamp(value) {
  const raw = String(value || "");
  if (raw.length >= 8) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return formatDate(new Date());
}

function setStatus(text) {
  els.status.textContent = text;
}

function loadLocalState() {
  try {
    state.stocks = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    state.stocks = [];
  }

  try {
    state.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    state.settings = { ...DEFAULT_SETTINGS };
  }

  try {
    state.lastPick = JSON.parse(localStorage.getItem(PICK_KEY) || "null");
  } catch {
    state.lastPick = null;
  }
}

function saveStocks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.stocks));
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function saveLastPick() {
  localStorage.setItem(PICK_KEY, JSON.stringify(state.lastPick));
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
  return {
    code: row.code,
    name: row.name || row.code,
    remark: row.remark || "",
    business: row.business || "",
    price: asNumber(row.price),
    high: asNumber(row.high),
    low: asNumber(row.low),
    open: asNumber(row.open),
    previousClose: asNumber(row.previous_close),
    changeAmount: asNumber(row.change_amount),
    changePercent: asNumber(row.change_percent),
    volume: asNumber(row.volume),
    turnover: asNumber(row.turnover),
    updatedAt: row.quote_date || "",
    refreshedAt: row.refreshed_at || "",
    createdAt: row.created_at || "",
    deleted: Boolean(row.deleted),
  };
}

function toDb(stock) {
  return {
    code: stock.code,
    name: stock.name || stock.code,
    remark: stock.remark || "",
    business: stock.business || "",
    price: numberOrNull(stock.price),
    high: numberOrNull(stock.high),
    low: numberOrNull(stock.low),
    open: numberOrNull(stock.open),
    previous_close: numberOrNull(stock.previousClose),
    change_amount: numberOrNull(stock.changeAmount),
    change_percent: numberOrNull(stock.changePercent),
    volume: numberOrNull(stock.volume),
    turnover: numberOrNull(stock.turnover),
    quote_date: stock.updatedAt || null,
    refreshed_at: stock.refreshedAt || null,
    deleted: Boolean(stock.deleted),
  };
}

async function loadRemoteState() {
  const cachedStocks = [...state.stocks];
  const cachedSettings = { ...state.settings };
  const [stocks, settingsRows] = await Promise.all([
    supabaseRequest(`${STOCK_TABLE}?select=*&deleted=eq.false&order=created_at.desc,code.asc`),
    supabaseRequest(`${SETTINGS_TABLE}?select=value&key=eq.${SETTINGS_ROW_KEY}&limit=1`),
  ]);

  state.stocks = Array.isArray(stocks) && stocks.length > 0 ? stocks.map(fromDb) : cachedStocks;
  if (Array.isArray(settingsRows) && settingsRows[0] && settingsRows[0].value) {
    state.settings = { ...DEFAULT_SETTINGS, ...settingsRows[0].value, pickTime: DEFAULT_SETTINGS.pickTime };
  } else {
    state.settings = cachedSettings;
  }
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
        },
      }),
    });
    return true;
  } catch {
    state.remoteReady = false;
    setStatus("在线设置保存失败，已保存在本地缓存");
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
    changeAmount: quotePrice(data.f169),
    changePercent: numberOrNull(data.f170),
    volume: numberOrNull(data.f47),
    turnover: numberOrNull(data.f48),
    updatedAt: quoteTimestamp(data.f86),
    refreshedAt: new Date().toISOString(),
  };
}

async function hydrateStock(entry) {
  const quote = await fetchQuote(entry.code);
  const profile = await fetchProfile(entry.code);
  return {
    ...entry,
    ...quote,
    name: entry.name || quote.name || profile.name || entry.code,
    business: profile.business || entry.business || "",
    remark: entry.remark || "",
    createdAt: entry.createdAt || new Date().toISOString(),
  };
}

function manualStock(entry) {
  return {
    ...entry,
    name: entry.name || entry.code,
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
  const query = state.query.trim().toLowerCase();
  if (!query) return state.stocks;
  return state.stocks.filter((stock) => {
    return [stock.code, stock.name, stock.remark, stock.business].some((value) =>
      String(value || "").toLowerCase().includes(query),
    );
  });
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

function renderPickResult() {
  if (!state.lastPick) {
    els.pickResult.textContent = EMPTY_PICK_TEXT;
    els.promptOutput.value = "";
    return;
  }
  const { pickedAt, reason } = state.lastPick;
  const stock = state.stocks.find((item) => item.code === state.lastPick.stock.code) || state.lastPick.stock;
  els.pickResult.innerHTML = `候选：<strong>${stock.name || stock.code}（${stock.code}）</strong>，现价 ${money(
    stock.price,
  )} 元，买入量 ${state.settings.lot} 手。${reason} <span class="muted">生成时间：${pickedAt}</span>`;
  els.promptOutput.value = buildPrompt(stock);
}

function render() {
  els.rows.textContent = "";
  const stocks = filteredStocks();
  els.empty.hidden = stocks.length > 0;
  renderSummary();

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
    nameLine.textContent = stock.name || stock.code;
    codeLine.className = "stock-code";
    codeLine.textContent = `（${stock.code}）`;
    cells.identity.append(nameLine, codeLine);

    cells.price.textContent = money(stock.price);
    setTrend(cells.change, stock.changePercent);
    cells.range.textContent = `${money(stock.high)} / ${money(stock.low)}`;
    cells.turnover.textContent = compactMoney(stock.turnover);
    cells.priceFit.textContent = priceFits(stock) ? "符合" : "超出";
    cells.priceFit.className = priceFits(stock) ? "fit" : "miss";
    cells.remark.textContent = stock.remark || stock.business || "-";
    cells.updatedAt.textContent = stock.updatedAt || "-";

    row.querySelector(".edit").addEventListener("click", () => editStock(stock.code));
    row.querySelector(".delete").addEventListener("click", () => deleteStock(stock.code));
    els.rows.appendChild(row);
  }

  renderPickResult();
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
  setStatus(`正在编辑 ${stock.name || stock.code}`);
}

async function deleteStock(code) {
  const stock = state.stocks.find((item) => item.code === code);
  state.stocks = state.stocks.filter((item) => item.code !== code);
  if (state.lastPick && state.lastPick.stock && state.lastPick.stock.code === code) {
    state.lastPick = null;
    saveLastPick();
  }
  saveStocks();
  clearForm();
  render();
  setStatus(`${stock ? stock.name || stock.code : code} 已删除，正在同步`);
  await patchRemoteStock(code, { deleted: true });
  setStatus(`${stock ? stock.name || stock.code : code} 已删除`);
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
        stock.code === editCode ? { ...stock, name: rawName || stock.name, remark } : stock,
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
    saveStocks();
    clearForm();
    render();
    setStatus(`${hydrated.name || hydrated.code} 已添加，正在同步`);
    await upsertRemoteStock(hydrated);
    setStatus(`${hydrated.name || hydrated.code} 已添加`);
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
  state.stocks = refreshed;
  saveStocks();
  render();
  setStatus(`已刷新 ${state.stocks.length} 只股票，正在同步`);
  for (const stock of state.stocks) {
    await upsertRemoteStock(stock);
  }
  setStatus(`已刷新 ${state.stocks.length} 只股票`);
}

function scoreStock(stock) {
  const price = Number(stock.price);
  const change = Number(stock.changePercent);
  const min = Number(state.settings.minPrice);
  const max = Number(state.settings.maxPrice);
  const span = Math.max(max - min, 1);
  const priceComfort = Number.isFinite(price) ? 1 - Math.min(Math.max((price - min) / span, 0), 1) : 0;
  const stability = Number.isFinite(change) ? Math.max(0, 1 - Math.abs(change) / 8) : 0.35;
  const liquidity = Number(stock.turnover) > 100000000 ? 1 : Number(stock.turnover) > 20000000 ? 0.6 : 0.25;
  const momentum = Number.isFinite(change) && change > -4 && change < 6 ? 1 : 0.25;
  return priceComfort * 30 + stability * 30 + liquidity * 20 + momentum * 20;
}

function eligibleStocks() {
  return state.stocks
    .filter(priceFits)
    .map((stock) => ({ ...stock, score: scoreStock(stock) }))
    .sort((a, b) => b.score - a.score);
}

function buildPrompt(selectedStock) {
  const candidates = eligibleStocks()
    .slice(0, 8)
    .map((stock, index) => {
      return `${index + 1}. ${stock.name || stock.code}（${stock.code}）：现价${money(stock.price)}元，涨跌幅${percent(
        stock.changePercent,
      )}，今高/今低${money(stock.high)}/${money(stock.low)}，成交额${compactMoney(stock.turnover)}，备注：${
        stock.remark || stock.business || "无"
      }`;
    })
    .join("\n");

  return `请你作为谨慎的 A 股分析助手，基于我提供的列表，从符合价格区间的股票里选出 1 只“买入候选”，并说明理由和风险点。我在下午两点半左右给你的列表，请结合今日实时数据进行分析。输出请包含但不限于：候选股票、为什么符合、需要回避的风险、买入量提醒、买法（例如：不追 68.5 元以上。理想买点：64.8–66.3 元附近低吸。止损：跌破 63.5 元，短线走。目标：先看 69.5–72 元。）。\n\n我的设置：价格区间 ${money(
    state.settings.minPrice,
  )} - ${money(state.settings.maxPrice)} 元；默认选股时间 ${DEFAULT_SETTINGS.pickTime}；计划买入 ${state.settings.lot} 手（${
    Number(state.settings.lot) * 100
  } 股）。\n\n候选：${selectedStock.name || selectedStock.code}（${selectedStock.code}）。\n\n候选列表：\n${candidates}`;
}

function pickStock({ automatic = false } = {}) {
  const candidates = eligibleStocks();
  if (candidates.length === 0) {
    const text = "没有股票同时满足当前价格区间和可用行情。请先添加股票、刷新行情，或调整价格区间。";
    els.pickResult.textContent = text;
    els.promptOutput.value = "";
    setStatus(text);
    return;
  }

  const stock = candidates[0];
  const pickedAt = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" }).format(new Date());
  const reason = `规则筛选分最高：价格在区间内，涨跌幅和流动性相对更稳。请复制提示词到 ChatGPT/Codex 做最终判断。`;
  state.lastPick = { stock, pickedAt, reason, automatic };
  saveLastPick();
  render();
  setStatus(automatic ? "已按设置时间生成候选" : "已生成候选");
}

function maybeAutoPick() {
  if (state.stocks.length === 0) return;
  const now = chinaNow();
  const today = formatDate(now);
  const [hour, minute] = DEFAULT_SETTINGS.pickTime.split(":").map(Number);
  const reached = now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute);
  if (!reached) return;
  if (state.lastPick && state.lastPick.date === today) return;
  pickStock({ automatic: true });
  if (state.lastPick) {
    state.lastPick.date = today;
    saveLastPick();
  }
}

async function saveSettingsFromForm(event) {
  event.preventDefault();
  const minPrice = Math.max(0, Number(els.minPrice.value) || 0);
  const maxPrice = Math.max(minPrice, Number(els.maxPrice.value) || DEFAULT_SETTINGS.maxPrice);
  const lot = Math.max(1, Math.floor(Number(els.lot.value) || DEFAULT_SETTINGS.lot));
  state.settings = {
    minPrice,
    maxPrice,
    pickTime: DEFAULT_SETTINGS.pickTime,
    lot,
  };
  fillSettingsForm();
  saveSettings();
  render();
  setStatus("选股设置已保存，正在同步");
  await upsertRemoteSettings();
  setStatus("选股设置已保存");
}

async function copyPrompt() {
  if (!els.promptOutput.value.trim()) {
    pickStock();
  }
  if (!els.promptOutput.value.trim()) return;
  try {
    await navigator.clipboard.writeText(els.promptOutput.value);
    setStatus("提示词已复制");
  } catch {
    els.promptOutput.select();
    setStatus("请手动复制提示词");
  }
}

els.form.addEventListener("submit", upsertStockFromForm);
els.clearForm.addEventListener("click", clearForm);
els.settingsForm.addEventListener("submit", saveSettingsFromForm);
els.refresh.addEventListener("click", refreshStocks);
els.pickNow.addEventListener("click", () => pickStock());
els.copyPrompt.addEventListener("click", copyPrompt);
els.search.addEventListener("input", () => {
  state.query = els.search.value;
  render();
});

loadLocalState();
fillSettingsForm();
updateClock();
render();
initRemoteState();
window.setInterval(updateClock, 1000);
window.setInterval(maybeAutoPick, 30000);
maybeAutoPick();
