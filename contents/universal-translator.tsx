import type { PlasmoCSConfig } from "plasmo"
import { useEffect } from "react"
import { Readability } from "@mozilla/readability"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  exclude_matches: ["https://news.ycombinator.com/*"],
  all_frames: false
}

// 控制翻译内容的可见性
const VISIBILITY_STYLE_ID = "hn-dual-visibility"
const HIDE_CSS = `.hn-dual-translation { display: none !important; }`

function applyVisibility(show: boolean) {
  let el = document.getElementById(VISIBILITY_STYLE_ID) as HTMLStyleElement | null
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
  chrome.runtime.sendMessage({ type: "TRANSLATION_PROGRESS", done, total }).catch(() => {})
}

function reportComplete(total: number) {
  chrome.runtime.sendMessage({ type: "TRANSLATION_COMPLETE", total }).catch(() => {})
}

function reportError(message: string) {
  chrome.runtime.sendMessage({ type: "TRANSLATION_ERROR", message }).catch(() => {})
}

// 检测文章内容
function detectArticle() {
  // 段落检测独立运行，不受 Readability 影响
  const SELECTORS =
    'article p, .post-content p, .entry-content p, .article-content p, ' +
    '.content p, .story-body p, .article-body p, .td-post-content p, ' +
    '.jeg_post_content p, main p, [role="main"] p, #content p, #main p'

  let paragraphs = Array.from(document.querySelectorAll(SELECTORS))
    .filter((p) => (p.textContent?.trim() || "").length > 50) as HTMLElement[]

  // 兜底：页面上所有 <p>，过滤掉导航/页脚噪声
  if (paragraphs.length === 0) {
    paragraphs = Array.from(document.querySelectorAll('p'))
      .filter((p) => {
        const text = p.textContent?.trim() || ""
        if (text.length < 50) return false
        const tag = p.closest('nav, footer, header, aside')
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
    console.error("Readability error (using document.title):", error)
  }

  return { title, paragraphs }
}

function reportStopped() {
  chrome.runtime.sendMessage({ type: "TRANSLATION_STOPPED" }).catch(() => {})
}

// 翻译取消标志
let shouldStop = false

// 翻译文章，段落双语对照，样式继承原页面
async function translatePage() {
  const article = detectArticle()
  if (!article) {
    reportError("未检测到文章内容")
    return
  }

  const total =
    (article.paragraphs.length > 0 ? 1 : 0) + // 标题
    article.paragraphs.filter((p) => !p.querySelector(".hn-dual-translation")).length
  let done = 0
  reportProgress(done, total)

  // 翻译标题
  const titleElement = document.querySelector("h1")
  if (titleElement && !titleElement.querySelector(".hn-dual-translation")) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "TRANSLATE",
        text: article.title,
        targetLang: "zh"
      })
      if (response.translation) {
        const div = document.createElement("div")
        div.className = "hn-dual-translation"
        div.style.cssText = `
          font-size: 0.75em;
          font-weight: normal;
          color: inherit;
          opacity: 0.65;
          margin-top: 6px;
        `
        div.textContent = response.translation
        titleElement.appendChild(div)
      }
    } catch (error) {
      console.error("Title translation error:", error)
    }
    done++
    reportProgress(done, total)
  }

  // 翻译段落
  for (const paragraph of article.paragraphs) {
    if (shouldStop) { reportStopped(); return }
    if (paragraph.querySelector(".hn-dual-translation")) continue

    const text = paragraph.textContent?.trim() || ""
    if (text.length < 20) continue

    try {
      const response = await chrome.runtime.sendMessage({
        type: "TRANSLATE",
        text,
        targetLang: "zh"
      })
      if (response.translation) {
        const div = document.createElement("div")
        div.className = "hn-dual-translation"
        div.style.cssText = `
          display: block;
          margin-top: 0.4em;
          opacity: 0.7;
        `
        div.textContent = response.translation
        paragraph.after(div)
      }
    } catch (error) {
      console.error("Paragraph translation error:", error)
    }

    done++
    reportProgress(done, total)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  reportComplete(total)
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
        sendResponse({ success: true })
      }
      if (message.type === "GET_ARTICLE_TEXT") {
        const documentClone = document.cloneNode(true) as Document
        const reader = new Readability(documentClone)
        const article = reader.parse()
        const text = (article?.textContent || '').slice(0, 8000)
        sendResponse({ title: article?.title || document.title, text })
      }
      return true
    })
  }, [])

  return null
}

export default UniversalTranslator
