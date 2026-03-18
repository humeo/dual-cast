import type { PlasmoCSConfig } from "plasmo"
import { useEffect } from "react"

export const config: PlasmoCSConfig = {
  matches: ["https://news.ycombinator.com/*"],
  all_frames: false
}

// 控制翻译内容的可见性
const VISIBILITY_STYLE_ID = "hn-dual-visibility"
const HIDE_CSS = `.hn-dual-translation, .hn-dual-comment-translation, .hn-dual-toptext-translation { display: none !important; }`

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

// 主组件
const HNEnhancer = () => {
  useEffect(() => {
    console.log("HN Dual: Enhancing Hacker News page...")

    // 初始化可见性
    chrome.storage.local.get(["showTranslations"], (result) => {
      applyVisibility(result.showTranslations !== false)
    })

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === "TRANSLATE_PAGE") {
        shouldStop = false
        sendResponse({ success: true })
        translateCurrentPage()
      }
      if (message.type === "STOP_TRANSLATION") {
        shouldStop = true
        if (lazyObserver) lazyObserver.disconnect()
        reportStopped(lazyDone, lazyTotal)
        sendResponse({ success: true })
      }
      if (message.type === "TOGGLE_TRANSLATIONS") {
        applyVisibility(message.show)
      }
      if (message.type === "GET_ARTICLE_TEXT") {
        const titleEls = Array.from(document.querySelectorAll('.titleline > a'))
        const titles = titleEls.map((el) => el.textContent?.trim()).filter(Boolean).join('\n')
        const toptext = document.querySelector('.toptext')?.textContent?.trim() || ''
        const comments = Array.from(document.querySelectorAll('.commtext'))
          .map((el) => el.textContent?.trim())
          .filter((t) => t && t.length > 20)
          .join('\n\n')
        const text = [titles, toptext, comments].filter(Boolean).join('\n\n').slice(0, 8000)
        sendResponse({ title: document.title, text })
      }
      return true
    })
  }, [])

  return null
}

// 向 popup 报告进度，同时持久化到 storage 供 popup 重新打开时恢复
function reportProgress(done: number, total: number) {
  chrome.runtime.sendMessage({ type: "GET_TAB_ID" }).then((res) => {
    chrome.storage.local.set({ translationState: { status: "translating", done, total, tabId: res?.tabId } })
  }).catch(() => {})
  chrome.runtime.sendMessage({ type: "TRANSLATION_PROGRESS", done, total }).catch(() => {})
}

function reportComplete(total: number) {
  chrome.storage.local.remove("translationState")
  chrome.runtime.sendMessage({ type: "TRANSLATION_COMPLETE", total }).catch(() => {})
}

function reportStopped(_done: number, _total: number) {
  chrome.storage.local.remove("translationState")
  chrome.runtime.sendMessage({ type: "TRANSLATION_STOPPED" }).catch(() => {})
}

// 翻译取消标志
let shouldStop = false

// 惰性翻译：用 IntersectionObserver 只翻译进入视口的内容
let lazyObserver: IntersectionObserver | null = null
let lazyTargetLang = "zh"
let lazyTotal = 0
let lazyDone = 0

async function translateElement(el: HTMLElement, type: "title" | "toptext" | "comment") {
  if (shouldStop || el.getAttribute("data-hn-dual-translated") === "true") return
  el.setAttribute("data-hn-dual-translated", "true")

  const text = el.textContent || ""
  try {
    const response = await chrome.runtime.sendMessage({
      type: "TRANSLATE", text, targetLang: lazyTargetLang
    })
    if (!response.translation) return

    const div = document.createElement("div")
    if (type === "title") {
      div.className = "hn-dual-translation"
      div.style.cssText = "color:#666;font-size:0.9em;margin-top:1px;margin-bottom:6px;line-height:1.4;padding:0;"
      div.textContent = response.translation
      const titleRow = el.closest(".athing")
      if (titleRow?.nextElementSibling) {
        const subtext = titleRow.nextElementSibling.querySelector(".subtext")
        if (subtext) subtext.parentElement?.insertBefore(div, subtext)
      }
    } else if (type === "toptext") {
      div.className = "hn-dual-toptext-translation"
      div.style.cssText = "background:#f6f6ef;padding:6px 8px 8px;margin-top:2px;margin-bottom:8px;border-left:2px solid #ff6600;color:#333;font-size:0.95em;line-height:1.5;"
      div.textContent = response.translation
      el.after(div)
    } else {
      div.className = "hn-dual-comment-translation"
      div.style.cssText = "background:#f6f6ef;padding:6px 8px 8px;margin-top:2px;margin-bottom:8px;border-left:2px solid #ff6600;color:#333;font-size:0.95em;line-height:1.5;"
      div.textContent = response.translation
      el.appendChild(div)
    }
  } catch (error) {
    console.error("Translation error:", error)
  }

  lazyDone++
  if (shouldStop) return
  reportProgress(lazyDone, lazyTotal)
  if (lazyDone >= lazyTotal) reportComplete(lazyTotal)
}

// 翻译当前页面（惰性模式）
async function translateCurrentPage() {
  console.log("开始惰性翻译页面...")

  const settings = await chrome.storage.sync.get(["targetLang"])
  lazyTargetLang = settings.targetLang || "zh"

  // 收集所有待翻译元素
  const titleLinks = Array.from(
    document.querySelectorAll('.titleline > a:not([data-hn-dual-translated])')
  ).filter((el) => (el.textContent || "").trim().length >= 5) as HTMLElement[]

  const topTexts = Array.from(
    document.querySelectorAll('.toptext:not([data-hn-dual-translated])')
  ).filter((el) => (el.textContent || "").trim().length >= 10) as HTMLElement[]

  const comments = Array.from(
    document.querySelectorAll('.commtext:not([data-hn-dual-translated])')
  ).filter((el) => (el.textContent || "").trim().length >= 10) as HTMLElement[]

  lazyTotal = titleLinks.length + topTexts.length + comments.length
  lazyDone = 0

  console.log(`[HN Dual] Found ${titleLinks.length} titles, ${topTexts.length} topTexts, ${comments.length} comments (total: ${lazyTotal})`)

  if (lazyTotal === 0) {
    reportComplete(0)
    return
  }

  reportProgress(0, lazyTotal)

  // 清理旧 observer
  if (lazyObserver) lazyObserver.disconnect()

  // rootMargin: 足够大确保整个页面的标题都被触发（评论页仍然惰性）
  lazyObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      if (shouldStop) {
        lazyObserver?.unobserve(entry.target)
        reportStopped(lazyDone, lazyTotal)
        continue
      }
      const el = entry.target as HTMLElement
      lazyObserver?.unobserve(el)
      const type = el.dataset.hnDualType as "title" | "toptext" | "comment"
      console.log(`[HN Dual] Translating ${type}: "${(el.textContent || "").slice(0, 40)}..."`)
      translateElement(el, type)
    }
  }, { rootMargin: "9999px 0px" })

  // 标记类型并观察
  for (const el of titleLinks) {
    el.dataset.hnDualType = "title"
    lazyObserver.observe(el)
  }
  for (const el of topTexts) {
    el.dataset.hnDualType = "toptext"
    lazyObserver.observe(el)
  }
  for (const el of comments) {
    el.dataset.hnDualType = "comment"
    lazyObserver.observe(el)
  }
}

export default HNEnhancer
