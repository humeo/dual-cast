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

// 检测文章内容（增强社交平台支持）
function detectArticle() {
  const host = location.hostname

  // 社交平台专用选择器
  const SOCIAL_SELECTORS: Record<string, string> = {
    "twitter.com": '[data-testid="tweetText"], article [lang]',
    "x.com": '[data-testid="tweetText"], article [lang]',
    "reddit.com": '[slot="text-body"] p, .RichTextJSON-root p, [data-click-id="text"] p, .md p, shreddit-comment [slot="comment"] p',
    "facebook.com": '[data-ad-preview="message"] div, [dir="auto"][style]',
    "linkedin.com": '.feed-shared-update-v2__description-wrapper span[dir="ltr"], .update-components-text span[dir="ltr"]',
  }

  // 匹配社交平台
  const socialKey = Object.keys(SOCIAL_SELECTORS).find((k) => host.includes(k))

  let paragraphs: HTMLElement[] = []

  if (socialKey) {
    paragraphs = Array.from(document.querySelectorAll(SOCIAL_SELECTORS[socialKey]))
      .filter((el) => (el.textContent?.trim() || "").length > 10) as HTMLElement[]
  }

  // 通用文章选择器（社交平台没匹配到或结果为空时使用）
  if (paragraphs.length === 0) {
    const SELECTORS =
      'article p, .post-content p, .entry-content p, .article-content p, ' +
      '.content p, .story-body p, .article-body p, .td-post-content p, ' +
      '.jeg_post_content p, main p, [role="main"] p, #content p, #main p'

    paragraphs = Array.from(document.querySelectorAll(SELECTORS))
      .filter((p) => (p.textContent?.trim() || "").length > 50) as HTMLElement[]
  }

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

  return { title, paragraphs, isSocial: !!socialKey }
}

// 翻译取消标志
let shouldStop = false

// 惰性翻译：用 IntersectionObserver 只翻译进入视口的内容
let lazyObserver: IntersectionObserver | null = null
let lazyTargetLang = "zh"
let lazyTotal = 0
let lazyDone = 0

async function translateParagraph(paragraph: HTMLElement) {
  if (shouldStop || paragraph.querySelector(".hn-dual-translation")) return

  const text = paragraph.textContent?.trim() || ""
  if (text.length < 20) return

  try {
    const response = await chrome.runtime.sendMessage({
      type: "TRANSLATE", text, targetLang: lazyTargetLang
    })
    if (response.translation) {
      const div = document.createElement("div")
      div.className = "hn-dual-translation"
      div.style.cssText = "display:block;margin-top:0.4em;opacity:0.7;"
      div.textContent = response.translation
      paragraph.after(div)
    }
  } catch (error) {
    console.error("Paragraph translation error:", error)
  }

  lazyDone++
  reportProgress(lazyDone, lazyTotal)
  if (lazyDone >= lazyTotal) reportComplete(lazyTotal)
}

// 翻译文章，段落双语对照，样式继承原页面（惰性模式）
async function translatePage() {
  const article = detectArticle()
  if (!article) {
    reportError("未检测到文章内容")
    return
  }

  const settings = await chrome.storage.sync.get(["targetLang"])
  lazyTargetLang = settings.targetLang || "zh"

  const untranslatedParas = article.paragraphs.filter((p) => !p.querySelector(".hn-dual-translation"))
  lazyTotal = untranslatedParas.length + (article.paragraphs.length > 0 ? 1 : 0) // +1 for title
  lazyDone = 0
  reportProgress(0, lazyTotal)

  // 翻译标题（立即翻译，不惰性）
  const titleElement = document.querySelector("h1")
  if (titleElement && !titleElement.querySelector(".hn-dual-translation")) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "TRANSLATE", text: article.title, targetLang: lazyTargetLang
      })
      if (response.translation) {
        const div = document.createElement("div")
        div.className = "hn-dual-translation"
        div.style.cssText = "font-size:0.75em;font-weight:normal;color:inherit;opacity:0.65;margin-top:6px;"
        div.textContent = response.translation
        titleElement.appendChild(div)
      }
    } catch (error) {
      console.error("Title translation error:", error)
    }
    lazyDone++
    reportProgress(lazyDone, lazyTotal)
  }

  // 清理旧 observer
  if (lazyObserver) lazyObserver.disconnect()

  // 惰性翻译段落（rootMargin: 提前 300px）
  lazyObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting || shouldStop) continue
      const el = entry.target as HTMLElement
      lazyObserver?.unobserve(el)
      translateParagraph(el)
    }
  }, { rootMargin: "300px 0px" })

  for (const para of untranslatedParas) {
    lazyObserver.observe(para)
  }
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
        let title = document.title
        let text = ''
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
            'article p, .post-content p, .entry-content p, .article-content p, ' +
            '.content p, .story-body p, .article-body p, .td-post-content p, ' +
            '.jeg_post_content p, main p, [role="main"] p, #content p, #main p'
          let paras = Array.from(document.querySelectorAll(SELECTORS))
            .filter((p) => (p.textContent?.trim() || '').length > 50)
          if (paras.length === 0) {
            paras = Array.from(document.querySelectorAll('p'))
              .filter((p) => {
                const t = p.textContent?.trim() || ''
                return t.length > 50 && !p.closest('nav, footer, header, aside')
              })
          }
          text = paras.map((p) => p.textContent?.trim()).filter(Boolean).join('\n\n').slice(0, 8000)
        }
        sendResponse({ title, text })
      }
      return true
    })
  }, [])

  return null
}

export default UniversalTranslator
