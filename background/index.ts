// Background service worker for handling translation requests

interface TranslationRequest {
  type: string
  text: string
  title?: string
  targetLang: string
}
const hnOriginatedTabs = new Set<number>()

// 检测新标签页是否从 HN 打开（右键新开标签、Cmd+Click 等）
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  chrome.tabs.get(details.sourceTabId, (sourceTab) => {
    if (chrome.runtime.lastError) return
    if (sourceTab.url?.includes("news.ycombinator.com")) {
      hnOriginatedTabs.add(details.tabId)
      console.log(`HN Dual: Tab ${details.tabId} opened from HN`)
    }
  })
})

// 标签页关闭时清理
chrome.tabs.onRemoved.addListener((tabId) => {
  hnOriginatedTabs.delete(tabId)
})

// 翻译缓存
const translationCache = new Map<string, string>()

// 批量请求队列
interface QueueItem {
  text: string
  targetLang: string
  resolve: (value: string) => void
  reject: (reason: Error) => void
}
const requestQueue: QueueItem[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
const BATCH_SIZE = 20
const BATCH_DELAY_MS = 100

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(flushQueue, BATCH_DELAY_MS)
}

async function flushQueue() {
  flushTimer = null
  if (requestQueue.length === 0) return

  const batch = requestQueue.splice(0, BATCH_SIZE)
  const settings = await chrome.storage.local.get(["apiKey", "apiProvider", "apiBaseUrl", "apiModel"])

  if (!settings.apiKey) {
    const err = new Error("请先在插件设置中配置 API Key")
    batch.forEach((item) => item.reject(err))
    return
  }

  const provider = settings.apiProvider || "openai"
  const baseUrl = (settings.apiBaseUrl || "https://api.openai.com").replace(/\/$/, "")
  const model = settings.apiModel || "gpt-4o-mini"

  // OpenAI 不支持批量，逐条发送
  if (provider === "openai") {
    for (const item of batch) {
      try {
        const translation = await translateWithOpenAI(item.text, item.targetLang, settings.apiKey, baseUrl, model)
        translationCache.set(`${item.text}:${item.targetLang}`, translation)
        item.resolve(translation)
      } catch (e) {
        item.reject(e as Error)
      }
    }
    return
  }

  // DeepL 批量请求
  if (provider === "deepl") {
    try {
      const texts = batch.map((item) => item.text)
      const targetLang = batch[0].targetLang
      const translations = await translateBatchWithDeepL(texts, targetLang, settings.apiKey)
      batch.forEach((item, i) => {
        translationCache.set(`${item.text}:${item.targetLang}`, translations[i])
        item.resolve(translations[i])
      })
    } catch (e) {
      batch.forEach((item) => item.reject(e as Error))
    }
    return
  }

  batch.forEach((item) => item.reject(new Error(`不支持的翻译服务: ${provider}`)))
}

// 监听来自 content script 的消息
chrome.runtime.onMessage.addListener((request: TranslationRequest, sender, sendResponse) => {
  // 检查当前标签页是否从 HN 打开
  if (request.type === "CHECK_HN_REFERRER") {
    const tabId = sender.tab?.id
    sendResponse({ isFromHN: tabId ? hnOriginatedTabs.has(tabId) : false })
    return true
  }

  if (request.type === "SUMMARIZE") {
    chrome.storage.local.get(["apiKey", "apiProvider", "openaiKeyForSummary", "apiBaseUrl", "apiModel"], async (settings) => {
      const key = settings.openaiKeyForSummary ||
        (settings.apiProvider === "openai" ? settings.apiKey : null)
      if (!key) {
        sendResponse({ error: "总结功能需要 OpenAI API Key" })
        return
      }
      const baseUrl = (settings.apiBaseUrl || "https://api.openai.com").replace(/\/$/, "")
      const model = settings.apiModel || "gpt-4o-mini"
      try {
        const summary = await summarizeWithOpenAI(request.text, request.title, key, baseUrl, model)
        sendResponse({ summary })
      } catch (e) {
        sendResponse({ error: (e as Error).message })
      }
    })
    return true
  }

  if (request.type === "TRANSLATE") {
    handleTranslation(request.text, request.targetLang)
      .then((translation) => {
        sendResponse({ translation })
      })
      .catch((error) => {
        console.error("Translation error:", error)
        sendResponse({ translation: null, error: error.message })
      })

    // 返回 true 表示异步响应
    return true
  }
})

// 处理翻译 - 走批量队列
async function handleTranslation(text: string, targetLang: string): Promise<string> {
  // 检查缓存
  const cacheKey = `${text}:${targetLang}`
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey)!
  }

  return new Promise((resolve, reject) => {
    requestQueue.push({ text, targetLang, resolve, reject })
    scheduleFlush()
  })
}

// OpenAI 翻译
async function translateWithOpenAI(text: string, targetLang: string, apiKey: string, baseUrl: string, model: string): Promise<string> {
  const langNames: Record<string, string> = {
    zh: "Chinese", en: "English", ja: "Japanese", ko: "Korean",
    de: "German", fr: "French", es: "Spanish", it: "Italian",
    ru: "Russian", pt: "Portuguese", ar: "Arabic", nl: "Dutch",
    pl: "Polish", tr: "Turkish", vi: "Vietnamese"
  }
  const targetLanguage = langNames[targetLang] || "Chinese"

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: `You are a professional technical translator. Detect the language of the input text. If it is already in ${targetLanguage}, return it unchanged. Otherwise, translate it to ${targetLanguage} accurately and naturally. Return only the result, no explanations.`
        },
        {
          role: "user",
          content: text
        }
      ],
      temperature: 0.3
    })
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(`OpenAI API 错误: ${error.error?.message || response.statusText}`)
  }

  const data = await response.json()
  return data.choices[0].message.content.trim()
}

// DeepL 批量翻译（一次请求多个文本）
// 返回的字符串若与原文相同，说明源语言已是目标语言，已跳过翻译
async function translateBatchWithDeepL(texts: string[], targetLang: string, apiKey: string): Promise<string[]> {
  const langMap: Record<string, string> = {
    zh: "ZH", en: "EN", ja: "JA", ko: "KO",
    de: "DE", fr: "FR", es: "ES", it: "IT", ru: "RU", pt: "PT",
    ar: "AR", nl: "NL", pl: "PL", tr: "TR", vi: "VI"
  }
  const targetLangCode = langMap[targetLang] || "ZH"
  const isFreeAPI = apiKey.endsWith(":fx")
  const apiUrl = isFreeAPI
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate"

  const params = new URLSearchParams({ target_lang: targetLangCode })
  texts.forEach((t) => params.append("text", t))

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `DeepL-Auth-Key ${apiKey}`
    },
    body: params
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`DeepL API 错误: ${response.status} ${error}`)
  }

  const data = await response.json()
  if (!data.translations || data.translations.length === 0) {
    throw new Error("DeepL API 返回空结果")
  }

  // 若检测到的源语言与目标语言相同，返回原文（跳过翻译）
  return data.translations.map((t: { text: string; detected_source_language: string }, i: number) => {
    const detectedLang = t.detected_source_language?.toLowerCase()
    const normalizedTarget = targetLangCode.toLowerCase().replace("-", "_").split("_")[0]
    if (detectedLang && detectedLang === normalizedTarget) {
      console.log(`[HN Dual] 跳过翻译: 源语言 (${detectedLang}) 与目标语言 (${normalizedTarget}) 相同`)
      return texts[i]
    }
    return t.text
  })
}

// AI 摘要
async function summarizeWithOpenAI(text: string, title: string, apiKey: string, baseUrl: string, model: string): Promise<string> {
  const truncated = text.slice(0, 8000)
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "你是专业的文章摘要助手。请用中文提炼核心要点，使用「• 」开头的要点列表，简洁明了，控制在5条以内，每条不超过50字。只输出要点，不要有标题或前言。"
        },
        {
          role: "user",
          content: `标题：${title}\n\n${truncated}`
        }
      ],
      temperature: 0.3
    })
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(`OpenAI API 错误: ${error.error?.message || response.statusText}`)
  }

  const data = await response.json()
  return data.choices[0].message.content.trim()
}

export {}
