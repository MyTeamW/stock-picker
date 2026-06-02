const STORAGE_KEY = "myteamw-stock-picker-v1";
const SETTINGS_KEY = "myteamw-stock-picker-settings-v1";
const SUPABASE_URL = "https://kawztespuaiztftoifdk.supabase.co";
const SUPABASE_KEY = "sb_publishable_Ydf2JJK06d4GMTE2awOSwg_3GZLTR27";
const STOCK_TABLE = "picker_stocks";
const TRACKER_TABLE = "stocks";
const TRACKER_URL = "https://myteamw.github.io/tracker/";
const SETTINGS_TABLE = "picker_settings";
const RESULT_TABLE = "picker_results";
const SETTINGS_ROW_KEY = "default";
const DEFAULT_USER_REQUIREMENTS = "价格区间 0.00 - 70.00 元；计划买入 1 手（100 股）。";
const CONCEPT_CACHE_KEY = "myteamw-stock-picker-concepts-v1";
const CONCEPT_CACHE_MAX_AGE = 3 * 24 * 60 * 60 * 1000;
const CONCEPT_FETCH_CONCURRENCY = 4;

const DEFAULT_SETTINGS = {
  minPrice: 0,
  maxPrice: 70,
  pickTime: "14:30",
  lot: 1,
  defaultPrompt: "",
  userRequirements: DEFAULT_USER_REQUIREMENTS,
  basePositions: {},
  conceptFilters: [],
};

const EMPTY_BUY_TEXT = "暂无 Codex 自动化选股结果。定时对话写入结果后这里会自动显示。";
const EMPTY_HOLDING_TEXT = "暂无持仓操作建议。填写底仓明细后，下一次自动化会生成对应建议。";

const state = {
  stocks: [],
  bigPool: [],
  conceptCache: {},
  conceptStatus: "idle",
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
  stockQuery: document.querySelector("#stockQueryInput"),
  buyLots: document.querySelector("#buyLotsInput"),
  buyPrice: document.querySelector("#buyPriceInput"),
  saveStock: document.querySelector("#saveStockButton"),
  clearForm: document.querySelector("#clearFormButton"),
  settingSummary: document.querySelector("#settingSummary"),
  holdingCount: document.querySelector("#holdingCount"),
  bigPoolList: document.querySelector("#bigPoolList"),
  bigPoolCount: document.querySelector("#bigPoolCount"),
  conceptChips: document.querySelector("#conceptChips"),
  conceptFilterSummary: document.querySelector("#conceptFilterSummary"),
  clearConceptFilter: document.querySelector("#clearConceptFilterButton"),
  refreshConcepts: document.querySelector("#refreshConceptsButton"),
  buyPickResult: document.querySelector("#buyPickResult"),
  holdingAdviceResult: document.querySelector("#holdingAdviceResult"),
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

function formatLots(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "";
  return num % 1 === 0 ? String(num) : num.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

function formatGeneratedAt(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(date)
    .replace(/\//gu, "-");
}

function percent(value) {
  const num = normalizePercentValue(value);
  return Number.isFinite(num) ? `${num.toFixed(2)}%` : "-";
}

function directPercent(value) {
  const num = Number(value);
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

function ratioPercent(current, base) {
  const currentNum = Number(current);
  const baseNum = Number(base);
  if (!Number.isFinite(currentNum) || !Number.isFinite(baseNum) || baseNum <= 0) return null;
  return ((currentNum - baseNum) / baseNum) * 100;
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
  const conceptFilters = Array.isArray(raw.conceptFilters)
    ? raw.conceptFilters.map(normalizeConcept).filter(Boolean)
    : [];
  const minPrice = Math.max(0, Number(raw.minPrice ?? DEFAULT_SETTINGS.minPrice) || DEFAULT_SETTINGS.minPrice);
  const maxPrice = Math.max(minPrice, Number(raw.maxPrice ?? DEFAULT_SETTINGS.maxPrice) || DEFAULT_SETTINGS.maxPrice);
  const lot = Math.max(1, Math.floor(Number(raw.lot ?? DEFAULT_SETTINGS.lot) || DEFAULT_SETTINGS.lot));
  const userRequirements = String(raw.userRequirements || "").trim() || DEFAULT_USER_REQUIREMENTS;
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    minPrice,
    maxPrice,
    pickTime: DEFAULT_SETTINGS.pickTime,
    lot,
    defaultPrompt: String(raw.defaultPrompt || ""),
    userRequirements,
    basePositions: { ...basePositions },
    conceptFilters: uniqueConcepts(conceptFilters),
  };
}

function normalizeConcept(value) {
  return String(value || "")
    .replace(/[【】[\]()（）]/gu, "")
    .replace(/概念|板块|方向/gu, "")
    .trim();
}

function conceptKey(value) {
  return normalizeConcept(value).toLocaleLowerCase("zh-CN").replace(/\s+/g, "");
}

function uniqueConcepts(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const concept = normalizeConcept(value);
    const key = conceptKey(concept);
    if (!concept || seen.has(key)) continue;
    seen.add(key);
    result.push(concept);
  }
  return result;
}

function stockConcepts(stock) {
  return uniqueConcepts(Array.isArray(stock && stock.concepts) ? stock.concepts : []);
}

function stockMatchesConcepts(stock, concepts = state.settings.conceptFilters || []) {
  if (!concepts.length) return true;
  const stockKeys = new Set(stockConcepts(stock).map(conceptKey));
  return concepts.every((concept) => stockKeys.has(conceptKey(concept)));
}

function filteredBigPoolStocks() {
  const concepts = state.settings.conceptFilters || [];
  return state.bigPool.filter((stock) => stock && stock.code && stockMatchesConcepts(stock, concepts));
}

function selectedConceptBadges(stock) {
  return (state.settings.conceptFilters || []).filter((concept) => stockMatchesConcepts(stock, [concept]));
}

function conceptOptions() {
  const counts = new Map();
  for (const stock of state.bigPool) {
    for (const concept of stockConcepts(stock)) {
      const key = conceptKey(concept);
      if (!key) continue;
      const existing = counts.get(key) || { concept, count: 0 };
      existing.count += 1;
      counts.set(key, existing);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.concept.localeCompare(b.concept, "zh-CN"));
}

function sanitizeConceptFilters({ sync = false } = {}) {
  const available = new Set(conceptOptions().map((item) => conceptKey(item.concept)));
  const current = state.settings.conceptFilters || [];
  if (available.size === 0) {
    return;
  }
  const filtered = current.filter((concept) => available.has(conceptKey(concept)));
  if (filtered.length === current.length) return;
  state.settings.conceptFilters = filtered;
  state.settings.defaultPrompt = buildDefaultPrompt();
  saveSettings();
  if (sync) scheduleSettingsSync("概念筛选已校正");
}

function basePositionFor(code) {
  return String((state.settings.basePositions || {})[normalizeCode(code)] || "").trim();
}

function basePositionEntries(value) {
  return String(value || "")
    .split(/\n|；|;/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const lotMatch = line.match(/(\d+(?:\.\d+)?)\s*手/u);
      const numbers = [...line.matchAll(/\d+(?:\.\d+)?/gu)].map((match) => ({
        value: Number(match[0]),
        index: match.index || 0,
      }));
      if (!lotMatch || numbers.length < 2) return null;
      const lotIndex = lotMatch.index || 0;
      const lots = Number(lotMatch[1]);
      const priceItem = numbers.find((item) => Math.abs(item.index - lotIndex) > 2 && item.value > 0);
      if (!Number.isFinite(lots) || lots <= 0 || !priceItem) return null;
      return { price: priceItem.value, lots };
    })
    .filter(Boolean);
}

function basePositionSummary(value) {
  const entries = basePositionEntries(value);
  if (entries.length === 0) return "";
  const totalLots = entries.reduce((sum, item) => sum + item.lots, 0);
  const totalCost = entries.reduce((sum, item) => sum + item.price * item.lots, 0);
  if (!Number.isFinite(totalLots) || totalLots <= 0) return "";
  return `合计 ${totalLots.toFixed(totalLots % 1 === 0 ? 0 : 2)} 手，均价 ${money(totalCost / totalLots)}`;
}

function formatBasePosition(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.replace(/\s*\n+\s*/g, "；");
}

function buildBasePositionLine(price, lots) {
  return `${formatLots(lots)}手 / ${money(price)}`;
}

function appendBasePosition(existing, nextLine) {
  return [String(existing || "").trim(), String(nextLine || "").trim()].filter(Boolean).join("\n");
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

function fromTrackerDb(row) {
  const asNumber = (value) => (value === null || value === undefined ? null : Number(value));
  const code = normalizeCode(row.code);
  const startPrice = asNumber(row.start_price);
  const highPrice = asNumber(row.high_price ?? row.high);
  const closePrice = asNumber(row.close_price ?? row.price);
  const latestPrice = asNumber(row.price ?? row.close_price);
  const latestHigh = asNumber(row.high ?? row.high_price);
  return {
    code,
    name: usefulStockName(row.name, code) || code,
    remark: row.remark || "",
    recommender: row.recommender || "",
    business: row.business || "",
    concepts: parseConceptArray(row.concepts || row.concept_tags || row.conceptTags || row.tags || row.boards),
    startDate: row.start_date || "",
    startPrice,
    closePrice,
    highPrice,
    price: latestPrice,
    high: latestHigh,
    low: asNumber(row.low),
    open: asNumber(row.open),
    previousClose: asNumber(row.previous_close),
    changePercent: normalizePercentValue(row.change_percent),
    turnover: asNumber(row.turnover),
    increasePercent: ratioPercent(highPrice, startPrice),
    highDrawdownPercent: ratioPercent(latestPrice || closePrice, highPrice),
    startDrawdownPercent: ratioPercent(latestPrice || closePrice, startPrice),
    updatedAt: normalizeDateText(row.last_quote_date || row.quote_date, row.refreshed_at),
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

function textList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function parseConceptArray(value) {
  if (Array.isArray(value)) return uniqueConcepts(value);
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return uniqueConcepts(parsed);
    } catch {
      // Fall through to delimiter parsing.
    }
    return uniqueConcepts(text.split(/[、，,；;\/｜|\n\r\t ]+/u));
  }
  return [];
}

function conceptCacheFresh(entry) {
  const fetchedAt = Date.parse(entry && entry.fetchedAt);
  return Number.isFinite(fetchedAt) && Date.now() - fetchedAt < CONCEPT_CACHE_MAX_AGE;
}

function loadConceptCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONCEPT_CACHE_KEY) || "{}");
    state.conceptCache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    state.conceptCache = {};
  }
}

function saveConceptCache() {
  localStorage.setItem(CONCEPT_CACHE_KEY, JSON.stringify(state.conceptCache));
}

function cachedConcepts(code) {
  const clean = normalizeCode(code);
  const entry = state.conceptCache[clean];
  if (!entry || !conceptCacheFresh(entry)) return [];
  return parseConceptArray(entry.concepts);
}

function applyCachedConcepts() {
  state.bigPool = state.bigPool.map((stock) => {
    const cached = cachedConcepts(stock.code);
    return cached.length ? { ...stock, concepts: cached } : stock;
  });
  sanitizeConceptFilters();
}

function eastmoneyF10Code(code) {
  const clean = normalizeCode(code);
  if (/^6|^9/.test(clean)) return `SH${clean}`;
  if (/^4|^8/.test(clean)) return `BJ${clean}`;
  return `SZ${clean}`;
}

function collectStrings(value, bucket = []) {
  if (typeof value === "string") {
    bucket.push(value);
    return bucket;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, bucket));
    return bucket;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => {
      if (/board|concept|plate|theme|题材|概念|板块|所属/iu.test(key)) collectStrings(item, bucket);
      else if (typeof item === "object") collectStrings(item, bucket);
    });
  }
  return bucket;
}

function conceptsFromText(text) {
  const normalized = String(text || "")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return [];
  const sections = [];
  const boardMatch = normalized.match(/所属板块\s*[:：]?\s*([\s\S]*?)(?:要点[二三四五六七八九十]|经营范围|主营业务|$)/u);
  if (boardMatch) sections.push(boardMatch[1]);
  for (const match of normalized.matchAll(/(?:概念题材|所属概念|核心题材|所属板块)\s*[:：]\s*([^。；;]+)/gu)) {
    sections.push(match[1]);
  }
  const source = sections.join(" ") || normalized;
  return uniqueConcepts(
    source
      .split(/[、，,；;\/｜|\n\r\t ]+/u)
      .map(normalizeConcept)
      .filter((item) => item && item.length >= 2 && item.length <= 18)
      .filter((item) => !/^(所属|板块|要点|核心题材|图片|暂无|无|--|最新价|涨跌幅)$/u.test(item)),
  );
}

function conceptsFromPayload(payload) {
  return uniqueConcepts(collectStrings(payload).flatMap(conceptsFromText));
}

function parseStructuredResult(prompt) {
  if (!prompt || typeof prompt !== "string") return null;
  try {
    const parsed = JSON.parse(prompt);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    return null;
  }
  return null;
}

function normalizeResultSection(section = {}, fallback = {}) {
  const source = section && typeof section === "object" ? section : {};
  return {
    title: source.title || fallback.title || "自动化分析结果",
    summary: source.summary || fallback.summary || "",
    rationale: textList(source.rationale || source.reasons || fallback.rationale),
    risks: textList(source.risks || fallback.risks),
    action: source.action || fallback.action || "",
    candidateCode: normalizeCode(source.candidate_code || source.candidateCode || fallback.candidateCode || ""),
    candidateName: source.candidate_name || source.candidateName || fallback.candidateName || "",
  };
}

function normalizeHoldingAdvice(value) {
  const rows = Array.isArray(value) ? value : value && Array.isArray(value.items) ? value.items : [];
  return rows
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      code: normalizeCode(item.code || item.candidate_code || ""),
      name: item.name || item.candidate_name || "",
      basePosition: item.base_position || item.basePosition || item.position || "",
      summary: item.summary || "",
      action: item.action || "",
      rationale: textList(item.rationale || item.reasons),
      risks: textList(item.risks),
    }))
    .filter((item) => item.code || item.name || item.summary || item.action);
}

function fromResultDb(row) {
  const flat = {
    title: row.title || "自动化选股结果",
    summary: row.summary || "",
    rationale: Array.isArray(row.rationale) ? row.rationale : [],
    risks: Array.isArray(row.risks) ? row.risks : [],
    action: row.action || "",
    candidateCode: row.candidate_code || "",
    candidateName: row.candidate_name || "",
  };
  const structured = parseStructuredResult(row.prompt || "");
  const buySource = structured && (structured.buy_recommendation || structured.buyRecommendation);
  const holdingSource = structured && (structured.holding_advice || structured.holdingAdvice);
  return {
    active: row.active !== false,
    generatedAt: row.generated_at || row.created_at || "",
    ...flat,
    prompt: row.prompt || "",
    buyRecommendation: normalizeResultSection(buySource || flat, flat),
    holdingAdvice: normalizeHoldingAdvice(holdingSource),
  };
}

async function loadRemoteState() {
  const cachedStocks = [...state.stocks];
  const cachedSettings = { ...state.settings };
  const stocks = await supabaseRequest(`${STOCK_TABLE}?select=*&deleted=eq.false&order=created_at.desc,code.asc`);

  state.stocks = Array.isArray(stocks) && stocks.length > 0 ? stocks.map(fromDb) : cachedStocks;
  try {
    const bigPool = await supabaseRequest(`${TRACKER_TABLE}?select=*&deleted=eq.false&order=created_at.desc,code.asc`);
    state.bigPool = Array.isArray(bigPool) ? bigPool.map(fromTrackerDb).filter((stock) => stock.code) : [];
  } catch {
    state.bigPool = [];
  }
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
    loadConceptCache();
    applyCachedConcepts();
    state.remoteReady = true;
    fillHoldingFormDefaults();
    render();
    setStatus("在线数据库已连接");
    refreshBigPoolConcepts().catch(() => {
      state.conceptStatus = "error";
      renderConceptFilter();
    });
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
          userRequirements: state.settings.userRequirements || DEFAULT_USER_REQUIREMENTS,
          basePositions: state.settings.basePositions || {},
          conceptFilters: state.settings.conceptFilters || [],
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

async function fetchJsonMaybe(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function fetchEastmoneyCoreConcepts(code) {
  const f10Code = eastmoneyF10Code(code);
  const urls = [
    `https://emweb.eastmoney.com/PC_HSF10/CoreConception/PageAjax?code=${encodeURIComponent(f10Code)}`,
    `https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax?code=${encodeURIComponent(f10Code)}`,
    `https://emweb.eastmoney.com/PC_HSF10/CoreConception/Index?code=${encodeURIComponent(f10Code)}&type=web`,
  ];
  for (const url of urls) {
    try {
      const payload = await fetchJsonMaybe(url);
      const concepts = typeof payload === "string" ? conceptsFromText(payload) : conceptsFromPayload(payload);
      if (concepts.length > 0) return concepts;
    } catch {
      // Try the next F10 host/shape. CORS or host changes should not break the page.
    }
  }
  return [];
}

async function fetchStockConcepts(stock) {
  const existing = stockConcepts(stock);
  if (existing.length > 0) return existing;
  const cached = cachedConcepts(stock.code);
  if (cached.length > 0) return cached;
  return fetchEastmoneyCoreConcepts(stock.code);
}

async function refreshBigPoolConcepts({ force = false } = {}) {
  if (!state.bigPool.length) return;
  const candidates = state.bigPool.filter((stock) => {
    if (!stock || !stock.code) return false;
    if (!force && stockConcepts(stock).length > 0) return false;
    if (!force && cachedConcepts(stock.code).length > 0) return false;
    return true;
  });
  if (candidates.length === 0) {
    applyCachedConcepts();
    render();
    return;
  }

  state.conceptStatus = "loading";
  renderConceptFilter();
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const stock = candidates[cursor];
      cursor += 1;
      const code = normalizeCode(stock.code);
      try {
        const concepts = force ? await fetchEastmoneyCoreConcepts(stock.code) : await fetchStockConcepts(stock);
        state.conceptCache[code] = {
          concepts,
          fetchedAt: new Date().toISOString(),
          source: concepts.length ? "eastmoney-f10-core-conception" : "unavailable",
        };
        if (concepts.length > 0) {
          state.bigPool = state.bigPool.map((item) => (normalizeCode(item.code) === code ? { ...item, concepts } : item));
        }
      } catch {
        state.conceptCache[code] = {
          concepts: [],
          fetchedAt: new Date().toISOString(),
          source: "unavailable",
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCEPT_FETCH_CONCURRENCY, candidates.length) }, worker));
  saveConceptCache();
  applyCachedConcepts();
  sanitizeConceptFilters({ sync: true });
  state.conceptStatus = "ready";
  render();
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

function fillHoldingFormDefaults() {
  if (els.buyLots && !els.buyLots.value) {
    els.buyLots.value = state.settings.lot || DEFAULT_SETTINGS.lot;
  }
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

function holdingStocks() {
  return state.stocks.filter((stock) => basePositionFor(stock.code) || stock.basePosition);
}

function setTrend(cell, value) {
  cell.textContent = percent(value);
  cell.classList.toggle("positive", Number(value) > 0);
  cell.classList.toggle("negative", Number(value) < 0);
}

function renderSummary() {
  const eligible = state.stocks.filter(priceFits).length;
  const holdingCount = holdingStocks().length;
  const lotShares = Number(state.settings.lot) * 100;
  els.settingSummary.textContent = `大池：${state.bigPool.length} 只；持仓：${holdingCount} 只；价格区间：${money(
    state.settings.minPrice,
  )} - ${money(state.settings.maxPrice)} 元；默认时间：${DEFAULT_SETTINGS.pickTime}；买入量：${
    state.settings.lot
  } 手（${lotShares} 股）；持仓池符合区间：${eligible} 只`;
  if (els.holdingCount) els.holdingCount.textContent = `持仓 ${holdingCount} 只`;
}

function buildCandidateLine(stock, index) {
  const displayIndex = Number(index) + 1;
  const basePosition = formatBasePosition(stock.basePosition || basePositionFor(stock.code)) || "未填写";
  const remark = stock.remark || stock.business || "无";
  return `${displayIndex}. ${displayStockName(stock)}（${stock.code}）：现价 ${money(stock.price)} 元，涨跌幅 ${percent(
    stock.changePercent,
  )}，今高/今低 ${money(stock.high)}/${money(stock.low)}，开盘/昨收 ${money(stock.open)}/${money(
    stock.previousClose,
  )}，底仓明细：${basePosition}，备注：${remark}`;
}

function buildBigPoolLine(stock, index) {
  const displayIndex = Number(index) + 1;
  const remark = stock.remark || stock.recommender || stock.business || "无";
  return `${displayIndex}. ${displayStockName(stock)}（${stock.code}）：最新价 ${money(stock.price || stock.closePrice)} 元，起始价 ${money(
    stock.startPrice,
  )} 元，最高价 ${money(stock.highPrice || stock.high)} 元，最高涨幅 ${directPercent(
    stock.increasePercent,
  )}，高位回撤 ${directPercent(stock.highDrawdownPercent)}，今日涨跌幅 ${percent(
    stock.changePercent,
  )}，更新时间 ${stock.updatedAt || "-"}，备注：${remark}`;
}

function scoreBigPoolStock(stock) {
  if (!stockMatchesConcepts(stock)) return -999;
  const price = Number(stock.price || stock.closePrice);
  if (!Number.isFinite(price) || price <= 0) return -999;
  if (price < Number(state.settings.minPrice) || price > Number(state.settings.maxPrice)) return -999;
  if (/ST|退/u.test(String(stock.name || ""))) return -999;

  let score = 0;
  score += price >= 6 && price <= 60 ? 18 : 8;
  const dailyChange = normalizePercentValue(stock.changePercent);
  if (Number.isFinite(dailyChange)) {
    if (dailyChange >= -1.5 && dailyChange <= 4.5) score += 26;
    else if (dailyChange > 4.5 && dailyChange <= 7.5) score += 17;
    else if (dailyChange >= -4 && dailyChange < -1.5) score += 12;
    else score += 4;
  }

  const drawdown = Number(stock.highDrawdownPercent);
  if (Number.isFinite(drawdown)) {
    if (drawdown >= -16 && drawdown <= -2) score += 22;
    else if (drawdown > -2 && drawdown <= 3) score += 14;
    else if (drawdown >= -28 && drawdown < -16) score += 8;
  }

  const startGain = Number(stock.startDrawdownPercent);
  if (Number.isFinite(startGain)) {
    if (startGain >= 0 && startGain <= 45) score += 16;
    else if (startGain > 45 && startGain <= 90) score += 9;
    else if (startGain < 0 && startGain >= -12) score += 6;
  }

  const turnover = Number(stock.turnover);
  if (Number.isFinite(turnover)) {
    if (turnover >= 500000000) score += 16;
    else if (turnover >= 100000000) score += 10;
    else if (turnover >= 30000000) score += 5;
  }

  const theme = `${stock.remark || ""} ${stock.recommender || ""}`;
  if (/通信|电力|新能源|半导体|智能|光|电子|材料|算力|AI/u.test(theme)) score += 8;
  if (/^(688|300|301)/.test(stock.code || "")) score -= 3;
  return score;
}

function rankedBigPoolStocks() {
  return filteredBigPoolStocks()
    .map((stock) => ({ ...stock, score: scoreBigPoolStock(stock) }))
    .sort((a, b) => b.score - a.score)
    .filter((stock) => stock.score > 0);
}

function buildDefaultPrompt() {
  const bigRanked = rankedBigPoolStocks();
  const lockedPool = filteredBigPoolStocks();
  const bigCandidates = (bigRanked.length > 0 ? bigRanked : lockedPool).slice(0, 12);
  const holdings = holdingStocks();
  const bigCandidateText = bigCandidates.map(buildBigPoolLine).join("\n") || "暂无可用大池股票。";
  const holdingText = holdings.map(buildCandidateLine).join("\n") || "暂无已填写底仓的持仓股票。";
  const lotShares = Number(state.settings.lot) * 100;
  const conceptText = (state.settings.conceptFilters || []).length
    ? `当前锁定概念：${state.settings.conceptFilters.join(" + ")}；大池中同时命中 ${lockedPool.length} 只。`
    : "当前未锁定概念，默认从全部大池中选择。";

  return [
    "请你作为谨慎的 A 股短线助手，今天要分开完成两个部分。",
    `今日选股推荐：从大池子（${TRACKER_URL}）中只推荐 1 只今日买入观察标的；以交易日 14:30 附近行情为主，可参考大池历史最高价、回撤、备注和流动性，但不要机械照搬页面排序。`,
    conceptText,
    "持仓操作建议：只对已经持仓的股票给后续操作建议；是否持仓以“底仓明细”非空为准，未填写底仓明细的股票不当作持仓处理。",
    `我的设置：价格区间 ${money(state.settings.minPrice)} - ${money(
      state.settings.maxPrice,
    )} 元；默认选股时间 ${DEFAULT_SETTINGS.pickTime}；计划买入 ${state.settings.lot} 手（${lotShares} 股）。`,
    `大池候选摘要：\n${bigCandidateText}`,
    `已持仓股票：\n${holdingText}`,
    "请输出两部分：第一部分是今日新买推荐，必须包含推荐股票、推荐理由、风险、理想买点、止损位、短线目标区间和买入量提醒；第二部分是每只持仓股的后续操作建议，明确持有、减仓、观察或止损条件。内容要聚焦结论、风险和触发条件，不要添加固定结尾套话。",
  ].join("\n\n");
}

function currentDefaultPrompt() {
  return state.settings.defaultPrompt || buildDefaultPrompt();
}

function renderPromptInputs() {
  els.userRequirements.value = state.settings.userRequirements || DEFAULT_USER_REQUIREMENTS;
}

function renderBigPoolList() {
  if (!els.bigPoolList || !els.bigPoolCount) return;
  renderConceptFilter();
  const total = state.bigPool.filter((stock) => stock && stock.code).length;
  const selectedConcepts = state.settings.conceptFilters || [];
  const stocks = filteredBigPoolStocks();
  els.bigPoolCount.textContent = selectedConcepts.length ? `${stocks.length}/${total} 只` : `${total} 只`;
  if (stocks.length === 0) {
    els.bigPoolList.textContent = selectedConcepts.length
      ? `没有同时命中 ${selectedConcepts.join(" + ")} 的股票`
      : "暂无大池股票";
    return;
  }

  els.bigPoolList.innerHTML = stocks
    .map((stock) => {
      const name = displayStockName(stock);
      const code = normalizeCode(stock.code);
      const badges = selectedConceptBadges(stock)
        .map((concept) => `<span class="pool-tag">${escapeHtml(concept)}</span>`)
        .join("");
      return `
        <a class="pool-item" href="https://stockpage.10jqka.com.cn/${code}/" target="_blank" rel="noopener noreferrer">
          <span class="pool-main">
            <span class="pool-name">${escapeHtml(name)}</span>
            ${badges ? `<span class="pool-tags">${badges}</span>` : ""}
          </span>
          <span class="pool-code">${escapeHtml(code)}</span>
        </a>
      `;
    })
    .join("");
}

function renderConceptFilter() {
  if (!els.conceptChips || !els.conceptFilterSummary || !els.clearConceptFilter) return;
  sanitizeConceptFilters();
  const selected = state.settings.conceptFilters || [];
  const options = conceptOptions();
  if (options.length === 0) {
    els.conceptChips.innerHTML = `<span class="concept-empty">${
      state.conceptStatus === "loading" ? "正在读取 F10 概念标签..." : "暂无可用概念标签"
    }</span>`;
  } else {
    els.conceptChips.innerHTML = options
      .map(({ concept, count }) => {
        const active = selected.some((item) => conceptKey(item) === conceptKey(concept));
        return `<button class="concept-chip${active ? " is-active" : ""}" type="button" data-concept="${escapeHtml(
          concept,
        )}" aria-pressed="${active}">
          <span>${escapeHtml(concept)}</span>
          <small>${count}</small>
        </button>`;
      })
      .join("");
  }
  els.clearConceptFilter.hidden = selected.length === 0;
  els.conceptFilterSummary.textContent = selected.length
    ? `已锁定：${selected.join(" + ")}；列表仅显示 F10 标签同时命中的股票。`
    : state.conceptStatus === "loading"
      ? "正在从东方财富 F10 核心题材读取所属板块标签。"
      : "未锁定概念，显示全部股池。概念来自个股 F10 所属板块。";
}

function renderResultBlock(container, section, emptyText) {
  if (!section) {
    container.textContent = emptyText;
    return;
  }
  const title = section.title || "自动化分析结果";
  const summary = section.summary || "";
  const generatedAt =
    state.automationResult && state.automationResult.generatedAt
      ? ` <span class="muted">生成时间：${escapeHtml(formatGeneratedAt(state.automationResult.generatedAt))}</span>`
      : "";
  container.innerHTML = `
    <div class="result-title"><strong>${escapeHtml(title)}</strong>${generatedAt}</div>
    ${summary ? `<div class="result-line">${escapeHtml(summary)}</div>` : ""}
    ${renderTextList("依据", section.rationale)}
    ${renderTextList("风险", section.risks)}
    ${
      section.action
        ? `<div class="result-line"><strong>短线操作：</strong><span class="result-emphasis">${escapeHtml(
            section.action,
          )}</span></div>`
        : ""
    }
  `;
}

function renderBuyPickResult() {
  if (state.automationResult) {
    renderResultBlock(els.buyPickResult, state.automationResult.buyRecommendation, EMPTY_BUY_TEXT);
    return;
  }

  els.buyPickResult.textContent = EMPTY_BUY_TEXT;
}

function renderHoldingAdvice() {
  const advice = state.automationResult ? state.automationResult.holdingAdvice : [];
  if (!advice || advice.length === 0) {
    els.holdingAdviceResult.textContent = EMPTY_HOLDING_TEXT;
    return;
  }

  els.holdingAdviceResult.innerHTML = `<div class="advice-list">${advice
    .map((item) => {
      const title = item.name || item.code ? `${item.name || item.code}${item.code ? `（${item.code}）` : ""}` : "持仓";
      const basePosition = formatBasePosition(item.basePosition || basePositionFor(item.code)) || "未填写";
      return `
        <article class="advice-item">
          <div class="advice-head">
            <strong>${escapeHtml(title)}</strong>
            <span class="muted">底仓明细：${escapeHtml(basePosition)}</span>
          </div>
          ${item.summary ? `<div class="result-line">${escapeHtml(item.summary)}</div>` : ""}
          ${
            item.action
              ? `<div class="result-line"><strong>后续操作：</strong><span class="result-emphasis">${escapeHtml(
                  item.action,
                )}</span></div>`
              : ""
          }
          ${renderTextList("依据", item.rationale)}
          ${renderTextList("风险", item.risks)}
        </article>
      `;
    })
    .join("")}</div>`;
}

function render() {
  els.rows.textContent = "";
  const stocks = filteredStocks();
  els.empty.hidden = stocks.length > 0;
  renderSummary();
  renderPromptInputs();
  renderBigPoolList();

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
    const baseDetail = document.createElement("div");
    const baseSummary = document.createElement("div");
    const baseText = stock.basePosition || basePositionFor(stock.code);
    const formattedBase = formatBasePosition(baseText);
    baseDetail.className = "base-position-detail";
    baseSummary.className = "base-position-summary";
    baseDetail.textContent = formattedBase || "未填写";
    baseDetail.classList.toggle("is-empty", !formattedBase);
    const summary = basePositionSummary(baseText);
    baseSummary.textContent = summary;
    baseSummary.hidden = !summary;
    cells.basePosition.append(baseDetail, baseSummary);
    cells.updatedAt.textContent = stock.updatedAt || "-";

    row.querySelector(".delete").addEventListener("click", () => deleteStock(stock.code));
    els.rows.appendChild(row);
  }

  renderBuyPickResult();
  renderHoldingAdvice();
}

async function loadAutomationResult() {
  try {
    const rows = await supabaseRequest(`${RESULT_TABLE}?select=*&active=eq.true&order=generated_at.desc&limit=1`);
    if (Array.isArray(rows) && rows[0]) {
      state.automationResult = fromResultDb(rows[0]);
      renderBuyPickResult();
      renderHoldingAdvice();
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
  fillHoldingFormDefaults();
  els.saveStock.textContent = "添加股票";
}

async function deleteStock(code) {
  const stock = state.stocks.find((item) => item.code === code);
  state.stocks = state.stocks.filter((item) => item.code !== code);
  if (state.settings.basePositions && state.settings.basePositions[code]) {
    delete state.settings.basePositions[code];
  }
  state.settings.defaultPrompt = buildDefaultPrompt();
  saveSettings();
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
  const query = els.stockQuery.value.trim();
  const buyLots = Math.max(1, Math.floor(Number(els.buyLots.value) || 0));
  const buyPrice = Number(els.buyPrice.value);

  try {
    if (!query) {
      setStatus("请输入股票代码或股票名称");
      return;
    }
    if (!Number.isFinite(buyPrice) || buyPrice <= 0) {
      setStatus("请输入有效买入价");
      return;
    }

    const rawCode = normalizeCode(query);
    let entry = {};
    if (isCode(rawCode)) entry = { code: rawCode, name: "" };
    else entry = await resolveStockByName(query);

    setStatus(`正在添加 ${entry.name || entry.code}`);
    const positionLine = buildBasePositionLine(buyPrice, buyLots);
    const previousPosition = basePositionFor(entry.code);
    const basePosition = appendBasePosition(previousPosition, positionLine);
    let hydrated;
    try {
      hydrated = await hydrateStock({ ...entry, basePosition });
    } catch {
      hydrated = manualStock({ ...entry, basePosition });
    }
    hydrated.basePosition = basePosition;
    state.settings.basePositions = { ...(state.settings.basePositions || {}), [hydrated.code]: basePosition };
    state.stocks = [hydrated, ...state.stocks.filter((stock) => stock.code !== hydrated.code)];
    state.stocks = attachBasePositions(state.stocks);
    state.settings.defaultPrompt = buildDefaultPrompt();
    saveStocks();
    saveSettings();
    clearForm();
    render();
    setStatus(`${displayStockName(hydrated)} 已添加，正在同步`);
    await upsertRemoteStock(hydrated);
    await upsertRemoteSettings();
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
  scheduleSettingsSync("底仓明细已保存");
}

function toggleConceptFilter(concept) {
  const normalized = normalizeConcept(concept);
  if (!normalized) return;
  const selected = state.settings.conceptFilters || [];
  const key = conceptKey(normalized);
  const exists = selected.some((item) => conceptKey(item) === key);
  state.settings.conceptFilters = exists
    ? selected.filter((item) => conceptKey(item) !== key)
    : uniqueConcepts([...selected, normalized]);
  state.settings.defaultPrompt = buildDefaultPrompt();
  saveSettings();
  render();
  scheduleSettingsSync("概念筛选已保存");
}

function clearConceptFilters() {
  if (!(state.settings.conceptFilters || []).length) return;
  state.settings.conceptFilters = [];
  state.settings.defaultPrompt = buildDefaultPrompt();
  saveSettings();
  render();
  scheduleSettingsSync("概念筛选已清空");
}

async function refreshConceptsFromButton() {
  setStatus("正在刷新 F10 概念标签");
  await refreshBigPoolConcepts({ force: true });
  setStatus("F10 概念标签已刷新");
}

els.form.addEventListener("submit", upsertStockFromForm);
els.clearForm.addEventListener("click", clearForm);
els.refresh.addEventListener("click", refreshStocks);
els.refreshDefaultPrompt.addEventListener("click", refreshDefaultPrompt);
els.userRequirements.addEventListener("input", saveUserRequirements);
els.conceptChips.addEventListener("click", (event) => {
  const button = event.target.closest("[data-concept]");
  if (!button) return;
  toggleConceptFilter(button.dataset.concept);
});
els.clearConceptFilter.addEventListener("click", clearConceptFilters);
els.refreshConcepts.addEventListener("click", () => {
  refreshConceptsFromButton().catch(() => setStatus("F10 概念标签刷新失败"));
});

loadLocalState();
fillHoldingFormDefaults();
updateClock();
render();
initRemoteState();
loadAutomationResult();
window.setInterval(updateClock, 1000);
