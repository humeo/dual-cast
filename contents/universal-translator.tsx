import { Readability } from "@mozilla/readability"
import type { PlasmoCSConfig } from "plasmo"
import { useEffect } from "react"

import { createLogger } from "~utils/logger"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  exclude_matches: ["https://news.ycombinator.com/*"],
  all_frames: false
}

const logger = createLogger("universal-translator")

// 控制翻译内容的可见性
const VISIBILITY_STYLE_ID = "hn-dual-visibility"
const HIDE_CSS = `.hn-dual-translation { display: none !important; }`
const MANUAL_CONTROL_ID = "hn-dual-manual-control"
const MANUAL_BATCH_SIZE = 5

interface ManualQueueItem {
  el: HTMLElement
  type: "title" | "paragraph"
  text: string
}

function applyVisibility(show: boolean) {
  let el = document.getElementById(
    VISIBILITY_STYLE_ID
  ) as HTMLStyleElement | null
  if (!show) {
    if (!el) {
      el = document.createElement("style")
      el.id = VISIBILITY_STYLE_ID
      document.head.appendChild(el)
    }
    el.textContent = HIDE_CSS
  } else {
    el?.remove()
  }
}

// 向 popup 报告进度
function reportProgress(done: number, total: number) {
  chrome.runtime
    .sendMessage({ type: "TRANSLATION_PROGRESS", done, total })
    .catch(() => {})
}

function reportComplete(total: number) {
  chrome.runtime
    .sendMessage({ type: "TRANSLATION_COMPLETE", total })
    .catch(() => {})
}

function reportStopped() {
  chrome.storage.local.remove("translationState")
  chrome.runtime.sendMessage({ type: "TRANSLATION_STOPPED" }).catch(() => {})
}

function reportError(message: string) {
  chrome.runtime
    .sendMessage({ type: "TRANSLATION_ERROR", message })
    .catch(() => {})
}

// 检测文章内容（增强社交平台支持）
function detectArticle() {
  const host = location.hostname

  // 社交平台专用选择器
  const SOCIAL_SELECTORS: Record<string, string> = {
    "twitter.com":
      '[data-testid="tweetText"], [data-testid="tweet"] [lang], article [lang], [role="article"] [lang]',
    "x.com":
      '[data-testid="tweetText"], [data-testid="tweet"] [lang], article [lang], [role="article"] [lang]',
    "reddit.com":
      '[slot="text-body"] p, .RichTextJSON-root p, [data-click-id="text"] p, .md p, shreddit-comment [slot="comment"] p',
    "facebook.com": '[data-ad-preview="message"] div, [dir="auto"][style]',
    "linkedin.com":
      '.feed-shared-update-v2__description-wrapper span[dir="ltr"], .update-components-text span[dir="ltr"]'
  }

  // 匹配社交平台
  const socialKey = Object.keys(SOCIAL_SELECTORS).find((k) => host.includes(k))

  let paragraphs: HTMLElement[] = []

  if (socialKey) {
    paragraphs = Array.from(
      document.querySelectorAll(SOCIAL_SELECTORS[socialKey])
    ).filter(
      (el) => (el.textContent?.trim() || "").length > 10
    ) as HTMLElement[]
  }

  // 通用文章选择器（社交平台没匹配到或结果为空时使用）
  if (paragraphs.length === 0) {
    const SELECTORS =
      "article p, .post-content p, .entry-content p, .article-content p, " +
      ".content p, .story-body p, .article-body p, .td-post-content p, " +
      '.jeg_post_content p, main p, [role="main"] p, #content p, #main p'

    paragraphs = Array.from(document.querySelectorAll(SELECTORS)).filter(
      (p) => (p.textContent?.trim() || "").length > 50
    ) as HTMLElement[]
  }

  // 兜底：页面上所有 <p>，过滤掉导航/页脚噪声
  if (paragraphs.length === 0) {
    paragraphs = Array.from(document.querySelectorAll("p")).filter((p) => {
      const text = p.textContent?.trim() || ""
      if (text.length < 50) return false
      const tag = p.closest("nav, footer, header, aside")
      return !tag
    }) as HTMLElement[]
  }

  if (paragraphs.length === 0) return null

  // Readability 单独 try/catch：失败时回退到 document.title
  let title = document.title
  try {
    const documentClone = document.cloneNode(true) as Document
    const reader = new Readability(documentClone)
    const article = reader.parse()
    if (article?.title) title = article.title
  } catch (error) {
    logger.error("Readability error; using document.title", error)
  }

  return { title, paragraphs, isSocial: !!socialKey }
}

// 翻译取消标志
let shouldStop = false

let manualTargetLang = "zh"
let manualQueue: ManualQueueItem[] = []
let manualTotal = 0
let manualDone = 0
let manualInFlight = false

async function translateManualItem(item: ManualQueueItem) {
  if (shouldStop || item.el.querySelector(".hn-dual-translation")) return

  const text = item.text.trim()
  if (text.length < 20) return

  try {
    const response = await chrome.runtime.sendMessage({
      type: "TRANSLATE",
      text,
      targetLang: manualTargetLang
    })
    if (response.translation) {
      const div = document.createElement("div")
      div.className = "hn-dual-translation"
      div.style.cssText =
        item.type === "title"
          ? "font-size:0.75em;font-weight:normal;color:inherit;opacity:0.65;margin-top:2px;margin-bottom:8px;"
          : "display:block;margin-top:0.15em;margin-bottom:0.6em;opacity:0.7;"
      div.textContent = response.translation
      if (item.type === "title") {
        item.el.appendChild(div)
      } else {
        item.el.after(div)
      }
    }
  } catch (error) {
    logger.error("Manual translation error", error)
  }

  manualDone++
  if (shouldStop) return
  reportProgress(manualDone, manualTotal)
  if (manualDone >= manualTotal) reportComplete(manualTotal)
}

function ensureManualControl() {
  let control = document.getElementById(MANUAL_CONTROL_ID)
  if (control) return control

  control = document.createElement("div")
  control.id = MANUAL_CONTROL_ID
  control.style.cssText = [
    "position:fixed",
    "right:18px",
    "bottom:18px",
    "z-index:2147483647",
    "display:flex",
    "gap:8px",
    "align-items:center",
    "padding:9px",
    "border:1px solid rgba(79,70,229,0.28)",
    "border-radius:8px",
    "background:#ffffff",
    "box-shadow:0 8px 24px rgba(15,23,42,0.16)",
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    "font-size:13px",
    "color:#334155"
  ].join(";")

  const status = document.createElement("span")
  status.dataset.role = "status"
  status.style.cssText = "min-width:58px;color:#64748b"

  const nextButton = document.createElement("button")
  nextButton.dataset.role = "next"
  nextButton.type = "button"
  nextButton.style.cssText = [
    "border:0",
    "border-radius:6px",
    "background:#4f46e5",
    "color:#fff",
    "padding:7px 11px",
    "font:inherit",
    "font-weight:650",
    "cursor:pointer"
  ].join(";")
  nextButton.addEventListener("click", () => {
    translateNextManualBatch()
  })

  const stopButton = document.createElement("button")
  stopButton.dataset.role = "stop"
  stopButton.type = "button"
  stopButton.textContent = "Stop"
  stopButton.style.cssText = [
    "border:1px solid #e2e8f0",
    "border-radius:6px",
    "background:#fff",
    "color:#64748b",
    "padding:7px 10px",
    "font:inherit",
    "cursor:pointer"
  ].join(";")
  stopButton.addEventListener("click", () => {
    shouldStop = true
    reportStopped()
    updateManualControl()
  })

  control.append(status, nextButton, stopButton)
  document.body.appendChild(control)
  return control
}

function updateManualControl() {
  if (manualTotal === 0) return

  const control = ensureManualControl()
  const status = control.querySelector<HTMLElement>('[data-role="status"]')
  const nextButton =
    control.querySelector<HTMLButtonElement>('[data-role="next"]')
  const stopButton =
    control.querySelector<HTMLButtonElement>('[data-role="stop"]')

  if (status) status.textContent = `${manualDone}/${manualTotal}`
  if (nextButton) {
    const remaining = manualQueue.length
    nextButton.disabled = manualInFlight || remaining === 0
    nextButton.textContent =
      remaining === 0
        ? "Done"
        : manualInFlight
          ? "Translating..."
          : `Translate next ${Math.min(MANUAL_BATCH_SIZE, remaining)}`
    nextButton.style.opacity = nextButton.disabled ? "0.65" : "1"
    nextButton.style.cursor = nextButton.disabled ? "default" : "pointer"
  }
  if (stopButton) {
    stopButton.style.display = manualInFlight ? "inline-block" : "none"
  }
}

async function translateNextManualBatch() {
  if (manualInFlight || manualQueue.length === 0) return

  shouldStop = false
  manualInFlight = true
  updateManualControl()

  let translatedInBatch = 0
  while (
    !shouldStop &&
    translatedInBatch < MANUAL_BATCH_SIZE &&
    manualQueue.length > 0
  ) {
    const item = manualQueue.shift()!
    await translateManualItem(item)
    translatedInBatch++
  }

  manualInFlight = false
  if (shouldStop) {
    reportStopped()
  } else if (manualQueue.length === 0) {
    reportComplete(manualTotal)
  }
  updateManualControl()
}

// 翻译文章，段落双语对照，样式继承原页面（手动批次模式）
async function translatePage() {
  let article = detectArticle()
  // SPA 页面内容可能还没渲染，等 800ms 重试一次
  if (!article) {
    await new Promise((r) => setTimeout(r, 800))
    article = detectArticle()
  }
  if (!article) {
    reportError("未检测到文章内容")
    return
  }

  const settings = await chrome.storage.sync.get(["targetLang"])
  manualTargetLang = settings.targetLang || "zh"

  const untranslatedParas = article.paragraphs.filter(
    (p) => !p.querySelector(".hn-dual-translation")
  )

  manualQueue = []
  const titleElement = document.querySelector("h1")
  if (titleElement && !titleElement.querySelector(".hn-dual-translation")) {
    manualQueue.push({
      el: titleElement as HTMLElement,
      type: "title",
      text: article.title
    })
  }

  for (const para of untranslatedParas) {
    manualQueue.push({
      el: para,
      type: "paragraph",
      text: para.textContent?.trim() || ""
    })
  }

  manualTotal = manualQueue.length
  manualDone = 0
  manualInFlight = false
  shouldStop = false

  if (manualTotal === 0) {
    reportComplete(0)
    updateManualControl()
    return
  }

  reportProgress(0, manualTotal)
  updateManualControl()
  await translateNextManualBatch()
}

// 主组件
const UniversalTranslator = () => {
  useEffect(() => {
    // 初始化可见性
    chrome.storage.local.get(["showTranslations"], (result) => {
      applyVisibility(result.showTranslations !== false)
    })

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === "TOGGLE_TRANSLATIONS") {
        applyVisibility(message.show)
      }
      if (message.type === "TRANSLATE_PAGE") {
        shouldStop = false
        sendResponse({ success: true })
        translatePage()
      }
      if (message.type === "STOP_TRANSLATION") {
        shouldStop = true
        reportStopped()
        updateManualControl()
        sendResponse({ success: true })
      }
      if (message.type === "GET_ARTICLE_TEXT") {
        let title = document.title
        let text = ""
        try {
          const documentClone = document.cloneNode(true) as Document
          const reader = new Readability(documentClone)
          const article = reader.parse()
          if (article?.textContent) text = article.textContent.slice(0, 8000)
          if (article?.title) title = article.title
        } catch (_) {}
        // Readability 失败时，从段落收集文本
        if (!text) {
          const SELECTORS =
            "article p, .post-content p, .entry-content p, .article-content p, " +
            ".content p, .story-body p, .article-body p, .td-post-content p, " +
            '.jeg_post_content p, main p, [role="main"] p, #content p, #main p'
          let paras = Array.from(document.querySelectorAll(SELECTORS)).filter(
            (p) => (p.textContent?.trim() || "").length > 50
          )
          if (paras.length === 0) {
            paras = Array.from(document.querySelectorAll("p")).filter((p) => {
              const t = p.textContent?.trim() || ""
              return t.length > 50 && !p.closest("nav, footer, header, aside")
            })
          }
          text = paras
            .map((p) => p.textContent?.trim())
            .filter(Boolean)
            .join("\n\n")
            .slice(0, 8000)
        }
        sendResponse({ title, text })
      }
      return true
    })
  }, [])

  return null
}

export default UniversalTranslator
