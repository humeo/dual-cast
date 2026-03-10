import { useEffect, useRef, useState } from "react"

type TransStatus = "idle" | "translating" | "done" | "stopped" | "error"
type SummaryStatus = "idle" | "summarizing" | "done" | "error"
type Tab = "translate" | "history"

interface HistoryItem {
  url: string
  title: string
  summary: string
  timestamp: number
}

function formatTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return "刚刚"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

function IndexPopup() {
  const [activeTab, setActiveTab] = useState<Tab>("translate")

  // 设置
  const [apiKey, setApiKey] = useState("")
  const [apiProvider, setApiProvider] = useState("deepl")
  const [openaiKeyForSummary, setOpenaiKeyForSummary] = useState("")
  const [saved, setSaved] = useState(false)
  const [showTranslations, setShowTranslations] = useState(true)

  // 翻译状态
  const [transStatus, setTransStatus] = useState<TransStatus>("idle")
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [transError, setTransError] = useState("")

  // 总结状态
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus>("idle")
  const [summary, setSummary] = useState("")
  const [summaryError, setSummaryError] = useState("")

  // 历史记录
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)

  const listenerRef = useRef<(msg: any) => void>()

  useEffect(() => {
    chrome.storage.local.get(
      ["apiKey", "apiProvider", "openaiKeyForSummary", "showTranslations", "summaryHistory"],
      (result) => {
        if (result.apiKey) setApiKey(result.apiKey)
        if (result.apiProvider) setApiProvider(result.apiProvider)
        if (result.openaiKeyForSummary) setOpenaiKeyForSummary(result.openaiKeyForSummary)
        setShowTranslations(result.showTranslations !== false)
        setHistory(result.summaryHistory || [])
      }
    )

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

  const handleSave = () => {
    chrome.storage.local.set({ apiKey, apiProvider, openaiKeyForSummary }, () => {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    })
  }

  const handleTranslate = async () => {
    setTransStatus("translating")
    setProgress({ done: 0, total: 0 })
    setTransError("")
    setSummaryStatus("idle")

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tabs[0]?.id) { setTransError("无法获取当前标签页"); setTransStatus("error"); return }
    try {
      await chrome.tabs.sendMessage(tabs[0].id, { type: "TRANSLATE_PAGE" })
    } catch {
      setTransError("无法连接到页面，请刷新后重试")
      setTransStatus("error")
    }
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

    // 保存到历史
    const newItem: HistoryItem = {
      url: tab.url || "",
      title: articleData.title,
      summary: response.summary,
      timestamp: Date.now()
    }
    chrome.storage.local.get(["summaryHistory"], (stored) => {
      const updated = [newItem, ...(stored.summaryHistory || [])].slice(0, 100)
      chrome.storage.local.set({ summaryHistory: updated })
      setHistory(updated)
    })
  }

  const handleClearHistory = () => {
    chrome.storage.local.set({ summaryHistory: [] })
    setHistory([])
    setExpandedIndex(null)
  }

  const isTranslating = transStatus === "translating"
  const isSummarizing = summaryStatus === "summarizing"

  const tabStyle = (tab: Tab): React.CSSProperties => ({
    flex: 1,
    padding: "8px",
    background: "none",
    border: "none",
    borderBottom: activeTab === tab ? "2px solid #ff6600" : "2px solid transparent",
    color: activeTab === tab ? "#ff6600" : "#666",
    fontWeight: activeTab === tab ? "600" : "400",
    fontSize: "14px",
    cursor: "pointer",
    transition: "all 0.2s"
  })

  return (
    <div style={{ width: "400px", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      {/* 标题 + 标签页 */}
      <div style={{ padding: "16px 20px 0" }}>
        <h2 style={{ margin: "0 0 12px 0", color: "#ff6600", fontSize: "16px" }}>🌐 HN Dual</h2>
        <div style={{ display: "flex", borderBottom: "1px solid #eee" }}>
          <button style={tabStyle("translate")} onClick={() => setActiveTab("translate")}>翻译 &amp; 总结</button>
          <button style={tabStyle("history")} onClick={() => setActiveTab("history")}>
            历史记录 {history.length > 0 && <span style={{ fontSize: "11px", color: "#999" }}>({history.length})</span>}
          </button>
        </div>
      </div>

      {/* 翻译 & 总结 Tab */}
      {activeTab === "translate" && (
        <div style={{ padding: "16px 20px 20px" }}>
          {/* 翻译服务 */}
          <div style={{ marginBottom: "12px" }}>
            <label style={{ display: "block", marginBottom: "6px", fontWeight: "500", fontSize: "13px" }}>翻译服务</label>
            <select
              value={apiProvider}
              onChange={(e) => setApiProvider(e.target.value)}
              style={{ width: "100%", padding: "7px", borderRadius: "4px", border: "1px solid #ddd", fontSize: "13px" }}>
              <option value="deepl">DeepL (推荐)</option>
              <option value="openai">OpenAI</option>
            </select>
          </div>

          {/* API Key */}
          <div style={{ marginBottom: "12px" }}>
            <label style={{ display: "block", marginBottom: "6px", fontWeight: "500", fontSize: "13px" }}>
              {apiProvider === "deepl" ? "DeepL API Key" : "OpenAI API Key"}
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={apiProvider === "deepl" ? "输入 DeepL API Key" : "输入 OpenAI API Key"}
              style={{ width: "100%", padding: "7px", borderRadius: "4px", border: "1px solid #ddd", fontSize: "13px", boxSizing: "border-box" }}
            />
            <p style={{ fontSize: "11px", color: "#999", margin: "3px 0 0 0" }}>
              {apiProvider === "deepl" ? (
                <><a href="https://www.deepl.com/pro-api" target="_blank" style={{ color: "#ff6600" }}>deepl.com/pro-api</a>（Free API 以 :fx 结尾）</>
              ) : (
                <a href="https://platform.openai.com/api-keys" target="_blank" style={{ color: "#ff6600" }}>platform.openai.com</a>
              )}
            </p>
          </div>

          {/* DeepL 用户额外配置 OpenAI Key 用于总结 */}
          {apiProvider === "deepl" && (
            <div style={{ marginBottom: "12px" }}>
              <label style={{ display: "block", marginBottom: "6px", fontWeight: "500", fontSize: "13px" }}>
                OpenAI API Key <span style={{ color: "#999", fontWeight: "400" }}>(AI 总结专用，选填)</span>
              </label>
              <input
                type="password"
                value={openaiKeyForSummary}
                onChange={(e) => setOpenaiKeyForSummary(e.target.value)}
                placeholder="输入 OpenAI API Key 以启用 AI 总结"
                style={{ width: "100%", padding: "7px", borderRadius: "4px", border: "1px solid #ddd", fontSize: "13px", boxSizing: "border-box" }}
              />
            </div>
          )}

          {/* 保存 */}
          <button
            onClick={handleSave}
            style={{
              width: "100%", padding: "8px", background: saved ? "#4caf50" : "#ff6600",
              color: "white", border: "none", borderRadius: "4px", fontSize: "13px",
              fontWeight: "500", cursor: "pointer", transition: "background 0.2s", marginBottom: "12px"
            }}>
            {saved ? "✓ 已保存" : "保存设置"}
          </button>

          {/* 翻译 + 显示/隐藏 */}
          <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
            <button
              onClick={isTranslating ? handleStop : handleTranslate}
              disabled={!isTranslating && !apiKey}
              style={{
                flex: 1, padding: "9px",
                background: isTranslating ? "#e53935" : "#0066cc",
                color: "white", border: "none", borderRadius: "4px", fontSize: "13px",
                fontWeight: "500", cursor: (!isTranslating && !apiKey) ? "not-allowed" : "pointer",
                transition: "background 0.2s"
              }}>
              {isTranslating ? "⏹ 停止翻译" : "🌐 翻译当前页面"}
            </button>
            <button
              onClick={handleToggleVisibility}
              title={showTranslations ? "隐藏所有翻译" : "显示所有翻译"}
              style={{
                padding: "9px 12px", background: showTranslations ? "#f0f0f0" : "#e8e8e8",
                color: showTranslations ? "#333" : "#999", border: "1px solid #ddd",
                borderRadius: "4px", fontSize: "13px", cursor: "pointer", whiteSpace: "nowrap"
              }}>
              {showTranslations ? "👁 显示" : "🙈 隐藏"}
            </button>
          </div>

          {/* AI 总结 */}
          <button
            onClick={handleSummarize}
            disabled={isSummarizing || (!apiKey && !openaiKeyForSummary)}
            style={{
              width: "100%", padding: "9px",
              background: isSummarizing ? "#999" : "#6200ea",
              color: "white", border: "none", borderRadius: "4px", fontSize: "13px",
              fontWeight: "500", cursor: (isSummarizing || (!apiKey && !openaiKeyForSummary)) ? "not-allowed" : "pointer",
              transition: "background 0.2s", marginBottom: "12px"
            }}>
            {isSummarizing ? "⏳ 正在总结..." : "✨ AI 总结当前页面"}
          </button>

          {/* 翻译状态 */}
          {transStatus !== "idle" && (
            <div style={{ padding: "10px 12px", borderRadius: "4px", fontSize: "13px", lineHeight: "1.5", marginBottom: "8px", ...transStatusStyle(transStatus) }}>
              {transStatus === "translating" && (
                <>
                  <div style={{ marginBottom: "6px" }}>
                    ⏳ 正在翻译...
                    {progress.total > 0 && <span style={{ float: "right" }}>{progress.done} / {progress.total}</span>}
                  </div>
                  {progress.total > 0 && (
                    <div style={{ height: "3px", background: "#ddd", borderRadius: "2px", overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${Math.round((progress.done / progress.total) * 100)}%`, background: "#ff6600", transition: "width 0.3s" }} />
                    </div>
                  )}
                </>
              )}
              {transStatus === "done" && <span>✓ 翻译完成，共 {progress.total} 条</span>}
              {transStatus === "stopped" && <span>⏹ 已停止，已翻译 {progress.done} / {progress.total} 条</span>}
              {transStatus === "error" && <span>✗ {transError || "翻译失败，请检查 API Key"}</span>}
            </div>
          )}

          {/* 总结结果 */}
          {summaryStatus !== "idle" && (
            <div style={{ padding: "10px 12px", borderRadius: "4px", fontSize: "13px", lineHeight: "1.6", ...summaryStatusStyle(summaryStatus) }}>
              {summaryStatus === "summarizing" && <span>⏳ AI 正在总结...</span>}
              {summaryStatus === "done" && (
                <div style={{ whiteSpace: "pre-line" }}>{summary}</div>
              )}
              {summaryStatus === "error" && <span>✗ {summaryError}</span>}
            </div>
          )}
        </div>
      )}

      {/* 历史记录 Tab */}
      {activeTab === "history" && (
        <div style={{ padding: "12px 20px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
            <span style={{ fontSize: "13px", color: "#666" }}>{history.length} 条记录</span>
            {history.length > 0 && (
              <button
                onClick={handleClearHistory}
                style={{ padding: "4px 10px", background: "none", border: "1px solid #ddd", borderRadius: "4px", fontSize: "12px", color: "#999", cursor: "pointer" }}>
                清空
              </button>
            )}
          </div>

          {history.length === 0 ? (
            <div style={{ textAlign: "center", color: "#bbb", fontSize: "13px", padding: "40px 0" }}>
              暂无历史记录<br />
              <span style={{ fontSize: "12px" }}>使用「AI 总结」后会保存在这里</span>
            </div>
          ) : (
            <div style={{ maxHeight: "480px", overflowY: "auto" }}>
              {history.map((item, i) => (
                <div
                  key={i}
                  style={{ borderBottom: "1px solid #f0f0f0", paddingBottom: "12px", marginBottom: "12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "4px" }}>
                    <a
                      href={item.url}
                      target="_blank"
                      style={{ color: "#0066cc", fontSize: "13px", fontWeight: "500", textDecoration: "none", flex: 1, marginRight: "8px", lineHeight: "1.4" }}>
                      {item.title}
                    </a>
                    <span style={{ fontSize: "11px", color: "#bbb", whiteSpace: "nowrap", flexShrink: 0 }}>
                      {formatTime(item.timestamp)}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: "12px", color: "#444", lineHeight: "1.6", whiteSpace: "pre-line",
                      maxHeight: expandedIndex === i ? "none" : "72px",
                      overflow: expandedIndex === i ? "visible" : "hidden",
                      cursor: "pointer"
                    }}
                    onClick={() => setExpandedIndex(expandedIndex === i ? null : i)}>
                    {item.summary}
                  </div>
                  {item.summary.split('\n').length > 3 && (
                    <button
                      onClick={() => setExpandedIndex(expandedIndex === i ? null : i)}
                      style={{ background: "none", border: "none", color: "#999", fontSize: "11px", cursor: "pointer", padding: "2px 0" }}>
                      {expandedIndex === i ? "收起" : "展开"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function transStatusStyle(s: TransStatus): React.CSSProperties {
  switch (s) {
    case "translating": return { background: "#fff8f0", border: "1px solid #ff6600", color: "#333" }
    case "done":        return { background: "#f0fff4", border: "1px solid #4caf50", color: "#2e7d32" }
    case "stopped":     return { background: "#f5f5f5", border: "1px solid #999",    color: "#555"   }
    case "error":       return { background: "#fff0f0", border: "1px solid #e53935", color: "#c62828" }
    default:            return {}
  }
}

function summaryStatusStyle(s: SummaryStatus): React.CSSProperties {
  switch (s) {
    case "summarizing": return { background: "#f3e5f5", border: "1px solid #9c27b0", color: "#333" }
    case "done":        return { background: "#f3e5f5", border: "1px solid #7b1fa2", color: "#333" }
    case "error":       return { background: "#fff0f0", border: "1px solid #e53935", color: "#c62828" }
    default:            return {}
  }
}

export default IndexPopup
