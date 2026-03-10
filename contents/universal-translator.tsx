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
  try {
    const documentClone = document.cloneNode(true) as Document
    const reader = new Readability(documentClone)
    const article = reader.parse()

    if (!article || !article.textContent || article.textContent.length < 200) {
      return null
    }

    const paragraphs = Array.from(
      document.querySelectorAll(
        'article p, .post-content p, .entry-content p, .article-content p, main p, [role="main"] p'
      )
    ).filter((p) => {
      const text = p.textContent?.trim() || ""
      return text.length > 50
    }) as HTMLElement[]

    return { title: article.title, paragraphs }
  } catch (error) {
    console.error("Article detection error:", error)
    return null
  }
}

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
        sendResponse({ success: true })
        translatePage()
      }
      return true
    })
  }, [])

  return null
}

export default UniversalTranslator
