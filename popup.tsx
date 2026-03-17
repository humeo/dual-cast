import { useEffect, useRef, useState } from "react"

type TransStatus = "idle" | "translating" | "done" | "stopped" | "error"
type SummaryStatus = "idle" | "summarizing" | "done" | "error"
type Tab = "translate" | "history" | "usage"

interface HistoryItem {
  url: string
  title: string
  summary: string
  timestamp: number
}

interface UsageStats {
  totalChars: number
  totalRequests: number
  deeplChars: number
  openaiChars: number
  lastReset: number
}

function formatTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return "刚刚"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/* ── Brand tokens ── */
const C = {
  primary: "#4f46e5",       // indigo-600
  primaryDark: "#3730a3",   // indigo-800
  primaryLight: "#eef2ff",  // indigo-50
  accent: "#7c3aed",        // violet-600
  accentLight: "#f5f3ff",   // violet-50
  gradientHeader: "linear-gradient(135deg, #4338ca 0%, #6366f1 50%, #818cf8 100%)",
  gradientBtn: "linear-gradient(135deg, #4338ca, #6366f1)",
  gradientSummary: "linear-gradient(135deg, #7c3aed, #a78bfa)",
  gradientStop: "linear-gradient(135deg, #dc2626, #ef4444)",
  gradientSave: "linear-gradient(135deg, #4338ca, #6366f1)",
  gradientProgress: "linear-gradient(90deg, #4338ca, #818cf8)",
  text: "#1e1b4b",
  textSec: "#6b7280",
  textMuted: "#9ca3af",
  border: "#e5e7eb",
  borderActive: "#4f46e5",
  bg: "#f8fafc",
  card: "#ffffff",
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  borderRadius: "10px",
  border: `1px solid ${C.border}`,
  fontSize: "13px",
  boxSizing: "border-box",
  outline: "none",
  background: C.card,
  color: C.text,
  fontFamily: "inherit",
  transition: "border-color 0.15s",
}

const labelStyle: React.CSSProperties = {
  display: "block",
  marginBottom: "6px",
  fontWeight: "600",
  fontSize: "11px",
  color: C.textSec,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
}

const TARGET_LANGUAGES = [
  { code: "zh", label: "中文 (Chinese)" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語 (Japanese)" },
  { code: "ko", label: "한국어 (Korean)" },
  { code: "de", label: "Deutsch (German)" },
  { code: "fr", label: "Français (French)" },
  { code: "es", label: "Español (Spanish)" },
  { code: "it", label: "Italiano (Italian)" },
  { code: "ru", label: "Русский (Russian)" },
  { code: "pt", label: "Português (Portuguese)" },
  { code: "ar", label: "العربية (Arabic)" },
  { code: "nl", label: "Nederlands (Dutch)" },
  { code: "pl", label: "Polski (Polish)" },
  { code: "tr", label: "Türkçe (Turkish)" },
  { code: "vi", label: "Tiếng Việt (Vietnamese)" },
]

function IndexPopup() {
  const [activeTab, setActiveTab] = useState<Tab>("translate")
  const [settingsOpen, setSettingsOpen] = useState(false)

  const [apiKey, setApiKey] = useState("")
  const [apiProvider, setApiProvider] = useState("deepl")
  const [openaiKeyForSummary, setOpenaiKeyForSummary] = useState("")
  const [apiBaseUrl, setApiBaseUrl] = useState("")
  const [apiModel, setApiModel] = useState("")
  const [openAIBatchSize, setOpenAIBatchSize] = useState(10)
  const [targetLang, setTargetLang] = useState("zh")
  const [saved, setSaved] = useState(false)
  const [showTranslations, setShowTranslations] = useState(true)

  const [transStatus, setTransStatus] = useState<TransStatus>("idle")
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [transError, setTransError] = useState("")

  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus>("idle")
  const [summary, setSummary] = useState("")
  const [summaryError, setSummaryError] = useState("")

  const [history, setHistory] = useState<HistoryItem[]>([])
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null)

  const listenerRef = useRef<(msg: any) => void>()

  useEffect(() => {
    chrome.storage.local.get(
      ["apiKey", "apiProvider", "openaiKeyForSummary", "apiBaseUrl", "apiModel", "openAIBatchSize", "showTranslations", "summaryHistory", "translationState"],
      (result) => {
        if (result.apiKey) setApiKey(result.apiKey)
        if (result.apiProvider) setApiProvider(result.apiProvider)
        if (result.openaiKeyForSummary) setOpenaiKeyForSummary(result.openaiKeyForSummary)
        if (result.apiBaseUrl) setApiBaseUrl(result.apiBaseUrl)
        if (result.apiModel) setApiModel(result.apiModel)
        if (result.openAIBatchSize) setOpenAIBatchSize(result.openAIBatchSize)
        setShowTranslations(result.showTranslations !== false)
        setHistory(result.summaryHistory || [])
        if (!result.apiKey) setSettingsOpen(true)
        // 恢复翻译状态（只恢复当前 tab 的状态）
        if (result.translationState && result.translationState.status === "translating") {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id === result.translationState.tabId) {
              setProgress({ done: result.translationState.done, total: result.translationState.total })
              setTransStatus("translating")
            }
          })
        }
      }
    )
    chrome.storage.sync.get(["targetLang"], (result) => {
      if (result.targetLang) setTargetLang(result.targetLang)
    })

    const listener = (message: any) => {
      if (message.type === "TRANSLATION_PROGRESS") {
        setProgress({ done: message.done, total: message.total })
        setTransStatus("translating")
      } else if (message.type === "TRANSLATION_COMPLETE") {
        setProgress({ done: message.total, total: message.total })
        setTransStatus("done")
      } else if (message.type === "TRANSLATION_STOPPED") {
        setTransStatus("stopped")
      } else if (message.type === "TRANSLATION_ERROR") {
        setTransError(message.message)
        setTransStatus("error")
      }
    }
    listenerRef.current = listener
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  // 切换到 usage tab 时刷新统计
  useEffect(() => {
    if (activeTab === "usage") {
      chrome.runtime.sendMessage({ type: "GET_USAGE_STATS" }).then((res) => {
        if (res?.stats) setUsageStats(res.stats)
      }).catch(() => {})
    }
  }, [activeTab])

  const handleSave = () => {
    chrome.storage.local.set({ apiKey, apiProvider, openaiKeyForSummary, apiBaseUrl, apiModel, openAIBatchSize }, () => {
      chrome.storage.sync.set({ targetLang }, () => {
        setSaved(true)
        setTimeout(() => { setSaved(false); setSettingsOpen(false) }, 1200)
      })
    })
  }

  const handleTranslate = async () => {
    setTransStatus("translating")
    setProgress({ done: 0, total: 0 })
    setTransError("")
    setSummaryStatus("idle")
    chrome.storage.local.remove("translationState")
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tabs[0]?.id) { setTransError("无法获取当前标签页"); setTransStatus("error"); return }
    const sendWithRetry = async (tabId: number) => {
      try {
        await chrome.tabs.sendMessage(tabId, { type: "TRANSLATE_PAGE" })
      } catch {
        // SPA 页面 content script 可能还没注册，等 800ms 重试一次
        await new Promise(r => setTimeout(r, 800))
        try {
          await chrome.tabs.sendMessage(tabId, { type: "TRANSLATE_PAGE" })
        } catch {
          setTransError("无法连接到页面，请刷新后重试")
          setTransStatus("error")
        }
      }
    }
    await sendWithRetry(tabs[0].id)
  }

  const handleStop = async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, { type: "STOP_TRANSLATION" }).catch(() => {})
  }

  const handleToggleVisibility = async () => {
    const next = !showTranslations
    setShowTranslations(next)
    chrome.storage.local.set({ showTranslations: next })
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, { type: "TOGGLE_TRANSLATIONS", show: next }).catch(() => {})
  }

  const handleSummarize = async () => {
    setSummaryStatus("summarizing")
    setSummary("")
    setSummaryError("")
    setTransStatus("idle")
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const tab = tabs[0]
    if (!tab?.id) { setSummaryError("无法获取当前标签页"); setSummaryStatus("error"); return }

    let articleData: { title: string; text: string } | null = null
    try {
      articleData = await chrome.tabs.sendMessage(tab.id, { type: "GET_ARTICLE_TEXT" })
    } catch {
      setSummaryError("无法连接到页面，请刷新后重试")
      setSummaryStatus("error")
      return
    }
    if (!articleData?.text) {
      setSummaryError("未检测到可总结的文章内容")
      setSummaryStatus("error")
      return
    }

    const response = await chrome.runtime.sendMessage({
      type: "SUMMARIZE",
      text: articleData.text,
      title: articleData.title
    })
    if (response.error) {
      setSummaryError(response.error)
      setSummaryStatus("error")
      return
    }

    setSummary(response.summary)
    setSummaryStatus("done")

    const newItem: HistoryItem = {
      url: tab.url || "",
      title: articleData.title,
      summary: response.summary,
      timestamp: Date.now()
    }
    // 用 URL 去重（忽略 hash 和 query，只比较 origin+pathname）
    const urlKey = (u: string) => { try { const p = new URL(u); return p.origin + p.pathname } catch { return u } }
    const newKey = urlKey(newItem.url)
    chrome.storage.local.get(["summaryHistory"], (stored) => {
      const existing: HistoryItem[] = stored.summaryHistory || []
      const deduped = existing.filter((item) => urlKey(item.url) !== newKey)
      const updated = [newItem, ...deduped].slice(0, 100)
      chrome.storage.local.set({ summaryHistory: updated })
      setHistory(updated)
    })
  }

  const handleClearHistory = () => {
    chrome.storage.local.set({ summaryHistory: [] })
    setHistory([])
    setExpandedIndex(null)
  }

  const handleExportHistory = () => {
    const data = JSON.stringify({ version: 1, exportedAt: Date.now(), summaryHistory: history }, null, 2)
    const blob = new Blob([data], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `dualcast-history-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImportHistory = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string)
        const imported: HistoryItem[] = Array.isArray(parsed.summaryHistory)
          ? parsed.summaryHistory.filter(
              (item: any) => item.url && item.title && item.summary && item.timestamp
            )
          : []
        if (imported.length === 0) { alert("No valid history found in file"); return }
        chrome.storage.local.get(["summaryHistory"], (stored) => {
          const existing: HistoryItem[] = stored.summaryHistory || []
          const existingUrls = new Set(existing.map((x) => `${x.url}:${x.timestamp}`))
          const merged = [...imported.filter((x) => !existingUrls.has(`${x.url}:${x.timestamp}`)), ...existing]
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 500)
          chrome.storage.local.set({ summaryHistory: merged })
          setHistory(merged)
        })
      } catch {
        alert("Failed to parse file — make sure it's a valid DualCast export")
      }
    }
    reader.readAsText(file)
    e.target.value = ""
  }

  const handleResetUsage = () => {
    chrome.runtime.sendMessage({ type: "RESET_USAGE_STATS" }).then(() => {
      setUsageStats({ totalChars: 0, totalRequests: 0, deeplChars: 0, openaiChars: 0, lastReset: Date.now() })
    }).catch(() => {})
  }

  const isTranslating = transStatus === "translating"
  const isSummarizing = summaryStatus === "summarizing"
  const hasApiKey = !!apiKey
  const hasSummaryKey = !!(apiKey || openaiKeyForSummary)

  return (
    <div style={{
      width: "400px",
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif",
      background: C.bg,
      color: C.text,
    }}>

      {/* ── Header ── */}
      <div style={{
        background: C.gradientHeader,
        padding: "18px 20px 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {/* Logo mark — two overlapping signal arcs */}
          <div style={{
            width: "38px", height: "38px", borderRadius: "12px",
            background: "rgba(255,255,255,0.15)",
            backdropFilter: "blur(8px)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "20px",
            border: "1px solid rgba(255,255,255,0.2)",
          }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
              <line x1="4" y1="22" x2="4" y2="15"/>
            </svg>
          </div>
          <div>
            <div style={{ color: "white", fontWeight: "700", fontSize: "17px", letterSpacing: "-0.4px" }}>DualCast</div>
            <div style={{ color: "rgba(255,255,255,0.7)", fontSize: "11px", letterSpacing: "0.02em" }}>Bilingual Reader & AI Summary</div>
          </div>
        </div>

        <button
          onClick={() => setSettingsOpen(!settingsOpen)}
          style={{
            background: settingsOpen ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.12)",
            border: "1px solid rgba(255,255,255,0.25)",
            borderRadius: "10px",
            color: "white",
            padding: "7px 13px",
            cursor: "pointer",
            fontSize: "12px",
            fontWeight: "500",
            display: "flex",
            alignItems: "center",
            gap: "6px",
            transition: "all 0.15s",
            fontFamily: "inherit",
          }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          {hasApiKey ? "Settings" : <span style={{ color: "#fde68a" }}>Setup</span>}
        </button>
      </div>

      {/* ── Settings Panel ── */}
      {settingsOpen && (
        <div style={{
          background: C.card,
          borderBottom: `1px solid ${C.border}`,
          padding: "18px 20px",
        }}>
          {/* Provider toggle */}
          <div style={{ marginBottom: "16px" }}>
            <label style={labelStyle}>Translation Provider</label>
            <div style={{ display: "flex", gap: "8px" }}>
              {([
                { value: "deepl", name: "DeepL", badge: "Recommended" },
                { value: "openai", name: "OpenAI", badge: "" },
              ] as const).map((p) => (
                <button
                  key={p.value}
                  onClick={() => setApiProvider(p.value)}
                  style={{
                    flex: 1,
                    padding: "10px 12px",
                    border: `2px solid ${apiProvider === p.value ? C.primary : C.border}`,
                    borderRadius: "10px",
                    background: apiProvider === p.value ? C.primaryLight : "#fafafa",
                    color: apiProvider === p.value ? C.primaryDark : C.textSec,
                    fontWeight: apiProvider === p.value ? "600" : "400",
                    fontSize: "13px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "6px",
                    fontFamily: "inherit",
                    transition: "all 0.15s",
                  }}>
                  {p.name}
                  {p.badge && (
                    <span style={{
                      fontSize: "9px", background: C.primary, color: "white",
                      borderRadius: "4px", padding: "2px 5px", fontWeight: "700",
                    }}>{p.badge}</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Target language */}
          <div style={{ marginBottom: "14px" }}>
            <label style={labelStyle}>Target Language</label>
            <select
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
              style={{ ...inputStyle, cursor: "pointer" }}>
              {TARGET_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>{lang.label}</option>
              ))}
            </select>
            <p style={{ margin: "5px 0 0", fontSize: "11px", color: C.textMuted }}>
              Auto-detect source language; skip when same as target
            </p>
          </div>

          {/* Translation API Key */}
          <div style={{ marginBottom: "14px" }}>
            <label style={labelStyle}>
              {apiProvider === "deepl" ? "DeepL API Key" : "OpenAI API Key"}
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={apiProvider === "deepl" ? "Ends with :fx for free tier" : "sk-..."}
              style={inputStyle}
            />
            {apiProvider === "deepl" && (
              <p style={{ margin: "5px 0 0", fontSize: "11px", color: C.textMuted }}>
                Get a free key at{" "}
                <a href="https://www.deepl.com/pro-api" target="_blank"
                  style={{ color: C.primary, textDecoration: "none", fontWeight: "500" }}>deepl.com/pro-api</a>
              </p>
            )}
          </div>

          {/* OpenAI key for summary (DeepL users) */}
          {apiProvider === "deepl" && (
            <div style={{ marginBottom: "14px" }}>
              <label style={labelStyle}>
                OpenAI Key{" "}
                <span style={{ color: C.textMuted, fontWeight: "400", textTransform: "none", letterSpacing: 0 }}>(for AI Summary, optional)</span>
              </label>
              <input
                type="password"
                value={openaiKeyForSummary}
                onChange={(e) => setOpenaiKeyForSummary(e.target.value)}
                placeholder="sk-..."
                style={inputStyle}
              />
            </div>
          )}

          {/* Custom endpoint + model */}
          <div style={{ display: "flex", gap: "10px", marginBottom: "18px" }}>
            <div style={{ flex: 3 }}>
              <label style={labelStyle}>API Base URL <span style={{ color: C.textMuted, fontWeight: "400", textTransform: "none", letterSpacing: 0 }}>(optional)</span></label>
              <input
                type="text"
                value={apiBaseUrl}
                onChange={(e) => setApiBaseUrl(e.target.value)}
                placeholder="https://api.openai.com"
                style={inputStyle}
              />
            </div>
            <div style={{ flex: 2 }}>
              <label style={labelStyle}>Model <span style={{ color: C.textMuted, fontWeight: "400", textTransform: "none", letterSpacing: 0 }}>(optional)</span></label>
              <input
                type="text"
                value={apiModel}
                onChange={(e) => setApiModel(e.target.value)}
                placeholder="gpt-4o-mini"
                style={inputStyle}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Batch Size</label>
              <input
                type="number"
                min={1}
                max={50}
                value={openAIBatchSize}
                onChange={(e) => setOpenAIBatchSize(Math.max(1, Math.min(50, parseInt(e.target.value) || 10)))}
                style={inputStyle}
              />
            </div>
          </div>

          <button
            onClick={handleSave}
            style={{
              width: "100%",
              padding: "10px",
              background: saved ? "#16a34a" : C.gradientSave,
              color: "white",
              border: "none",
              borderRadius: "10px",
              fontSize: "13px",
              fontWeight: "600",
              cursor: "pointer",
              transition: "all 0.2s",
              fontFamily: "inherit",
            }}>
            {saved ? "Saved" : "Save Settings"}
          </button>
        </div>
      )}

      {/* ── Tabs ── */}
      <div style={{
        display: "flex",
        background: C.card,
        borderBottom: `1px solid ${C.border}`,
        padding: "0 12px",
      }}>
        {([
          { key: "translate" as Tab, label: "Translate & Summary", icon: (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 8l6 6"/><path d="M4 14l6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/>
              <path d="M22 22l-5-10-5 10"/><path d="M14 18h6"/>
            </svg>
          )},
          { key: "history" as Tab, label: history.length > 0 ? `History (${history.length})` : "History", icon: (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
          )},
          { key: "usage" as Tab, label: "Usage", icon: (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>
            </svg>
          )},
        ]).map(({ key, label, icon }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            style={{
              flex: 1,
              padding: "11px 8px",
              background: "none",
              border: "none",
              borderBottom: activeTab === key ? `2.5px solid ${C.primary}` : "2.5px solid transparent",
              color: activeTab === key ? C.primary : C.textMuted,
              fontWeight: activeTab === key ? "600" : "400",
              fontSize: "12.5px",
              cursor: "pointer",
              transition: "all 0.15s",
              fontFamily: "inherit",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px",
            }}>
            {icon}
            {label}
          </button>
        ))}
      </div>

      {/* ── Translate & Summary Tab ── */}
      {activeTab === "translate" && (
        <div style={{ padding: "16px 18px 20px" }}>

          {/* No API key notice */}
          {!hasApiKey && (
            <div style={{
              background: "#fef3c7",
              border: "1px solid #fde68a",
              borderRadius: "10px",
              padding: "12px 14px",
              marginBottom: "14px",
              fontSize: "12.5px",
              color: "#92400e",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              lineHeight: "1.5",
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              Click Settings above to configure your API key
            </div>
          )}

          {/* Action buttons — two cards side by side */}
          <div style={{ display: "flex", gap: "10px", marginBottom: "14px" }}>
            {/* Translate button */}
            <button
              onClick={isTranslating ? handleStop : handleTranslate}
              disabled={!isTranslating && !hasApiKey}
              style={{
                flex: 1,
                padding: "16px 10px",
                background: isTranslating
                  ? C.gradientStop
                  : hasApiKey ? C.gradientBtn : "#e5e7eb",
                color: "white",
                border: "none",
                borderRadius: "14px",
                fontSize: "13px",
                fontWeight: "600",
                cursor: (!isTranslating && !hasApiKey) ? "not-allowed" : "pointer",
                transition: "all 0.2s",
                fontFamily: "inherit",
                boxShadow: hasApiKey
                  ? (isTranslating ? "0 4px 14px rgba(220,38,38,0.3)" : "0 4px 14px rgba(67,56,202,0.25)")
                  : "none",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "8px",
              }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {isTranslating ? (
                  <><rect x="6" y="6" width="12" height="12" rx="2"/></>
                ) : (
                  <><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></>
                )}
              </svg>
              {isTranslating ? "Stop" : "Translate"}
            </button>

            {/* AI Summary button */}
            <button
              onClick={handleSummarize}
              disabled={isSummarizing || !hasSummaryKey}
              style={{
                flex: 1,
                padding: "16px 10px",
                background: isSummarizing
                  ? C.accent
                  : hasSummaryKey ? C.gradientSummary : "#e5e7eb",
                color: "white",
                border: "none",
                borderRadius: "14px",
                fontSize: "13px",
                fontWeight: "600",
                cursor: (isSummarizing || !hasSummaryKey) ? "not-allowed" : "pointer",
                transition: "all 0.2s",
                fontFamily: "inherit",
                boxShadow: hasSummaryKey ? "0 4px 14px rgba(124,58,237,0.25)" : "none",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "8px",
              }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
              {isSummarizing ? "Analyzing..." : "AI Summary"}
            </button>
          </div>

          {/* Toggle visibility — subtle inline control */}
          <button
            onClick={handleToggleVisibility}
            style={{
              width: "100%",
              padding: "8px",
              background: "none",
              border: `1px solid ${C.border}`,
              borderRadius: "10px",
              fontSize: "12px",
              color: C.textSec,
              cursor: "pointer",
              fontFamily: "inherit",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px",
              transition: "all 0.15s",
              marginBottom: "14px",
            }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {showTranslations ? (
                <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>
              ) : (
                <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></>
              )}
            </svg>
            {showTranslations ? "Hide Translations" : "Show Translations"}
          </button>

          {/* Translation progress / status */}
          {transStatus !== "idle" && (
            <div style={{
              background: C.card,
              border: `1px solid ${transStatus === "done" ? "#bbf7d0" : transStatus === "error" ? "#fecaca" : transStatus === "stopped" ? C.border : "#c7d2fe"}`,
              borderRadius: "12px",
              padding: "14px",
              marginBottom: summaryStatus !== "idle" ? "10px" : 0,
            }}>
              {transStatus === "translating" && (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                    <span style={{ fontSize: "12.5px", fontWeight: "600", color: C.primaryDark }}>Translating...</span>
                    {progress.total > 0 && (
                      <span style={{ fontSize: "11px", color: C.textMuted, fontWeight: "500", fontVariantNumeric: "tabular-nums" }}>
                        {progress.done} / {progress.total}
                      </span>
                    )}
                  </div>
                  {progress.total > 0 && (
                    <>
                      <div style={{ height: "6px", background: "#f1f5f9", borderRadius: "99px", overflow: "hidden" }}>
                        <div style={{
                          height: "100%",
                          width: `${Math.round((progress.done / progress.total) * 100)}%`,
                          background: C.gradientProgress,
                          borderRadius: "99px",
                          transition: "width 0.35s ease",
                        }} />
                      </div>
                      <div style={{ textAlign: "right", fontSize: "10px", color: C.textMuted, marginTop: "4px", fontVariantNumeric: "tabular-nums" }}>
                        {Math.round((progress.done / progress.total) * 100)}%
                      </div>
                    </>
                  )}
                </>
              )}
              {transStatus === "done" && (
                <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "#15803d", fontWeight: "500" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
                  </svg>
                  Done — {progress.total} items translated
                </div>
              )}
              {transStatus === "stopped" && (
                <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: C.textSec, fontWeight: "500" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="6" y="6" width="12" height="12" rx="2"/>
                  </svg>
                  Stopped — {progress.done} / {progress.total} completed
                </div>
              )}
              {transStatus === "error" && (
                <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "#b91c1c", fontWeight: "500" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                  </svg>
                  {transError || "Translation failed — check your API key"}
                </div>
              )}
            </div>
          )}

          {/* Summary result */}
          {summaryStatus !== "idle" && (
            <div style={{
              background: summaryStatus === "done" ? C.accentLight : C.card,
              border: `1px solid ${summaryStatus === "error" ? "#fecaca" : "#ddd6fe"}`,
              borderRadius: "12px",
              padding: "14px",
            }}>
              {summaryStatus === "summarizing" && (
                <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: C.accent, fontWeight: "500" }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "spin 2s linear infinite" }}>
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                  </svg>
                  Analyzing article...
                </div>
              )}
              {summaryStatus === "done" && (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "10px" }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                    </svg>
                    <span style={{ fontSize: "11px", fontWeight: "700", color: C.accent, textTransform: "uppercase", letterSpacing: "0.06em" }}>AI Summary</span>
                  </div>
                  <div style={{ whiteSpace: "pre-line", fontSize: "13px", color: "#374151", lineHeight: "1.8" }}>{summary}</div>
                </>
              )}
              {summaryStatus === "error" && (
                <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "#b91c1c", fontWeight: "500" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                  </svg>
                  {summaryError}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── History Tab ── */}
      {activeTab === "history" && (
        <div style={{ padding: "14px 18px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
            <span style={{ fontSize: "11px", color: C.textMuted, fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              {history.length} summaries
            </span>
            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              {/* Import button */}
              <label style={{
                padding: "5px 10px",
                background: "none",
                border: `1px solid ${C.border}`,
                borderRadius: "8px",
                fontSize: "11px",
                color: C.textMuted,
                cursor: "pointer",
                fontFamily: "inherit",
                display: "flex",
                alignItems: "center",
                gap: "4px",
                transition: "all 0.15s",
                userSelect: "none",
              }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                Import
                <input type="file" accept=".json" onChange={handleImportHistory} style={{ display: "none" }} />
              </label>
              {/* Export button */}
              {history.length > 0 && (
                <button
                  onClick={handleExportHistory}
                  style={{
                    padding: "5px 10px",
                    background: "none",
                    border: `1px solid ${C.border}`,
                    borderRadius: "8px",
                    fontSize: "11px",
                    color: C.textMuted,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                    transition: "all 0.15s",
                  }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  Export
                </button>
              )}
              {/* Clear button */}
              {history.length > 0 && (
                <button
                  onClick={handleClearHistory}
                  style={{
                    padding: "5px 10px",
                    background: "none",
                    border: `1px solid ${C.border}`,
                    borderRadius: "8px",
                    fontSize: "11px",
                    color: C.textMuted,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    transition: "all 0.15s",
                  }}>
                  Clear
                </button>
              )}
            </div>
          </div>

          {history.length === 0 ? (
            <div style={{ textAlign: "center", padding: "48px 0 40px" }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ margin: "0 auto 16px" }}>
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              <div style={{ color: C.textMuted, fontSize: "13px", lineHeight: "1.7" }}>
                No summaries yet
              </div>
              <div style={{ color: "#d1d5db", fontSize: "12px", marginTop: "4px" }}>
                Use AI Summary and results will appear here
              </div>
            </div>
          ) : (
            <div style={{ maxHeight: "460px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "10px" }}>
              {history.map((item, i) => (
                <div
                  key={i}
                  style={{
                    background: C.card,
                    borderRadius: "12px",
                    border: `1px solid ${C.border}`,
                    padding: "14px",
                    transition: "border-color 0.15s",
                  }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
                    <a
                      href={item.url}
                      target="_blank"
                      style={{
                        color: C.primary,
                        fontSize: "12.5px",
                        fontWeight: "600",
                        textDecoration: "none",
                        flex: 1,
                        marginRight: "10px",
                        lineHeight: "1.5",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}>
                      {item.title}
                    </a>
                    <span style={{ fontSize: "10px", color: "#d1d5db", whiteSpace: "nowrap", flexShrink: 0, paddingTop: "2px" }}>
                      {formatTime(item.timestamp)}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: "12.5px",
                      color: C.textSec,
                      lineHeight: "1.8",
                      whiteSpace: "pre-line",
                      maxHeight: expandedIndex === i ? "none" : "80px",
                      overflow: expandedIndex === i ? "visible" : "hidden",
                      cursor: "pointer",
                      maskImage: expandedIndex === i ? "none" : "linear-gradient(to bottom, black 55%, transparent 100%)",
                    }}
                    onClick={() => setExpandedIndex(expandedIndex === i ? null : i)}>
                    {item.summary}
                  </div>
                  <button
                    onClick={() => setExpandedIndex(expandedIndex === i ? null : i)}
                    style={{
                      background: "none",
                      border: "none",
                      color: C.accent,
                      fontSize: "11px",
                      fontWeight: "500",
                      cursor: "pointer",
                      padding: "6px 0 0",
                      fontFamily: "inherit",
                      display: "flex",
                      alignItems: "center",
                      gap: "3px",
                      opacity: 0.7,
                    }}>
                    {expandedIndex === i ? "Collapse" : "Expand"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Usage Tab ── */}
      {activeTab === "usage" && (
        <div style={{ padding: "16px 18px 20px" }}>
          {!usageStats ? (
            <div style={{ textAlign: "center", padding: "40px 0", color: C.textMuted, fontSize: "13px" }}>Loading...</div>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                <span style={{ fontSize: "11px", color: C.textMuted, fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Today's Usage
                </span>
                <button
                  onClick={handleResetUsage}
                  style={{
                    padding: "5px 10px", background: "none", border: `1px solid ${C.border}`,
                    borderRadius: "8px", fontSize: "11px", color: C.textMuted, cursor: "pointer",
                    fontFamily: "inherit", transition: "all 0.15s",
                  }}>
                  Reset
                </button>
              </div>

              {/* Stats cards */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "16px" }}>
                {[
                  { label: "Characters", value: usageStats.totalChars.toLocaleString(), color: C.primary },
                  { label: "Requests", value: usageStats.totalRequests.toLocaleString(), color: C.accent },
                  { label: "DeepL Chars", value: usageStats.deeplChars.toLocaleString(), color: "#0ea5e9" },
                  { label: "OpenAI Chars", value: usageStats.openaiChars.toLocaleString(), color: "#10b981" },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{
                    background: C.card, border: `1px solid ${C.border}`, borderRadius: "12px",
                    padding: "14px", textAlign: "center",
                  }}>
                    <div style={{ fontSize: "20px", fontWeight: "700", color, letterSpacing: "-0.5px" }}>{value}</div>
                    <div style={{ fontSize: "10px", color: C.textMuted, fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: "4px" }}>{label}</div>
                  </div>
                ))}
              </div>

              {/* Estimated cost */}
              <div style={{
                background: C.card, border: `1px solid ${C.border}`, borderRadius: "12px",
                padding: "14px",
              }}>
                <div style={{ fontSize: "11px", color: C.textMuted, fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "10px" }}>
                  Estimated Cost
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {usageStats.deeplChars > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12.5px" }}>
                      <span style={{ color: C.textSec }}>DeepL (Free: 500K/mo)</span>
                      <span style={{ fontWeight: "600", color: C.text }}>
                        ${(usageStats.deeplChars / 1_000_000 * 20).toFixed(4)}
                        <span style={{ color: C.textMuted, fontWeight: "400" }}> / Pro $20/M</span>
                      </span>
                    </div>
                  )}
                  {usageStats.openaiChars > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12.5px" }}>
                      <span style={{ color: C.textSec }}>OpenAI (gpt-4o-mini)</span>
                      <span style={{ fontWeight: "600", color: C.text }}>
                        ~${(usageStats.openaiChars / 4 / 1_000_000 * 0.15 + usageStats.openaiChars / 4 / 1_000_000 * 0.6).toFixed(4)}
                      </span>
                    </div>
                  )}
                  {usageStats.totalChars === 0 && (
                    <div style={{ fontSize: "12.5px", color: C.textMuted, textAlign: "center", padding: "8px 0" }}>
                      No usage yet today
                    </div>
                  )}
                </div>
              </div>

              <p style={{ margin: "12px 0 0", fontSize: "11px", color: C.textMuted, lineHeight: "1.6", textAlign: "center" }}>
                Lazy translation is enabled — only visible content is translated to save API usage.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default IndexPopup
