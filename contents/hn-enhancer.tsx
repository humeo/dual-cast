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

function reportStopped() {
  chrome.runtime.sendMessage({ type: "TRANSLATION_STOPPED" }).catch(() => {})
}

// 翻译取消标志
let shouldStop = false

// 翻译当前页面
async function translateCurrentPage() {
  console.log("开始翻译页面...")

  const settings = await chrome.storage.sync.get(["targetLang"])
  const targetLang = settings.targetLang || "zh"

  // 先统计总数
  const titleLinks = Array.from(
    document.querySelectorAll('.titleline > a:not([data-hn-dual-translated])')
  ).filter((el) => (el.textContent || "").trim().length >= 5)

  const topTexts = Array.from(
    document.querySelectorAll('.toptext:not([data-hn-dual-translated])')
  ).filter((el) => (el.textContent || "").trim().length >= 10)

  const comments = Array.from(
    document.querySelectorAll('.commtext:not([data-hn-dual-translated])')
  ).filter((el) => (el.textContent || "").trim().length >= 10)

  const total = titleLinks.length + topTexts.length + comments.length
  let done = 0

  reportProgress(done, total)

  try {
    // 翻译标题
    for (const link of titleLinks) {
      if (shouldStop) { reportStopped(); return }
      const titleElement = link as HTMLAnchorElement
      titleElement.setAttribute('data-hn-dual-translated', 'true')

      const text = titleElement.textContent || ""
      try {
        const response = await chrome.runtime.sendMessage({
          type: "TRANSLATE",
          text,
          targetLang
        })

        if (response.translation) {
          const translationDiv = document.createElement('div')
          translationDiv.className = 'hn-dual-translation'
          translationDiv.style.cssText = `
            color: #666;
            font-size: 0.9em;
            margin-top: 4px;
            line-height: 1.4;
            padding: 4px 0;
          `
          translationDiv.textContent = response.translation

          const titleRow = titleElement.closest('.athing')
          if (titleRow && titleRow.nextElementSibling) {
            const subtext = titleRow.nextElementSibling.querySelector('.subtext')
            if (subtext) {
              subtext.parentElement?.insertBefore(translationDiv, subtext)
            }
          }
        }
      } catch (error) {
        console.error("Translation error:", error)
      }

      done++
      reportProgress(done, total)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }

    // 翻译 Ask HN 帖子正文
    for (const topText of topTexts) {
      if (shouldStop) { reportStopped(); return }
      const topTextElement = topText as HTMLElement
      topTextElement.setAttribute('data-hn-dual-translated', 'true')

      const text = topTextElement.textContent || ""
      try {
        const response = await chrome.runtime.sendMessage({
          type: "TRANSLATE",
          text,
          targetLang
        })

        if (response.translation) {
          const translationDiv = document.createElement('div')
          translationDiv.className = 'hn-dual-toptext-translation'
          translationDiv.style.cssText = `
            background: #f6f6ef;
            padding: 8px;
            margin-top: 8px;
            border-left: 2px solid #ff6600;
            color: #333;
            font-size: 0.95em;
            line-height: 1.5;
          `
          translationDiv.textContent = response.translation
          topTextElement.after(translationDiv)
        }
      } catch (error) {
        console.error("Translation error:", error)
      }

      done++
      reportProgress(done, total)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }

    // 翻译评论
    for (const comment of comments) {
      if (shouldStop) { reportStopped(); return }
      const commentElement = comment as HTMLElement
      commentElement.setAttribute('data-hn-dual-translated', 'true')

      const text = commentElement.textContent || ""
      try {
        const response = await chrome.runtime.sendMessage({
          type: "TRANSLATE",
          text,
          targetLang
        })

        if (response.translation) {
          const translationDiv = document.createElement('div')
          translationDiv.className = 'hn-dual-comment-translation'
          translationDiv.style.cssText = `
            background: #f6f6ef;
            padding: 8px;
            margin-top: 8px;
            border-left: 2px solid #ff6600;
            color: #333;
            font-size: 0.95em;
            line-height: 1.5;
          `
          translationDiv.textContent = response.translation
          commentElement.appendChild(translationDiv)
        }
      } catch (error) {
        console.error("Translation error:", error)
      }

      done++
      reportProgress(done, total)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }

    console.log("翻译完成！")
    reportComplete(total)
  } catch (error) {
    console.error("翻译失败:", error)
    reportError(error instanceof Error ? error.message : "翻译失败")
  }
}

export default HNEnhancer
