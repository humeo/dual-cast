import type { PlasmoCSConfig } from "plasmo"
import { useEffect, useState } from "react"
import { Readability } from "@mozilla/readability"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  exclude_matches: ["https://news.ycombinator.com/*"],
  all_frames: false
}

// 判断当前页面是否从 HN 跳转过来
async function isFromHackerNews(): Promise<boolean> {
  // 同标签页跳转：referrer 直接包含 HN 域名
  if (document.referrer.includes("news.ycombinator.com")) {
    console.log("HN Dual: referrer is HN")
    return true
  }

  // 新标签页打开：background 通过 webNavigation 追踪
  try {
    const response = await chrome.runtime.sendMessage({ type: "CHECK_HN_REFERRER" })
    console.log("HN Dual: background check result:", response?.isFromHN)
    return response?.isFromHN ?? false
  } catch (error) {
    console.error("HN Dual: CHECK_HN_REFERRER error:", error)
    return false
  }
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

    return {
      title: article.title,
      content: article.textContent,
      paragraphs
    }
  } catch (error) {
    console.error("Article detection error:", error)
    return null
  }
}

// 翻译文章
async function translateArticle(article: {
  title: string
  content: string
  paragraphs: HTMLElement[]
}) {
  const titleElement = document.querySelector("h1")
  if (titleElement && !titleElement.querySelector(".hn-dual-translation")) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "TRANSLATE",
        text: article.title,
        targetLang: "zh"
      })

      if (response.translation) {
        const translationDiv = document.createElement("div")
        translationDiv.className = "hn-dual-translation"
        translationDiv.style.cssText = `
          color: #666;
          font-size: 0.8em;
          margin-top: 8px;
          font-weight: normal;
        `
        translationDiv.textContent = response.translation
        titleElement.appendChild(translationDiv)
      }
    } catch (error) {
      console.error("Title translation error:", error)
    }
  }

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
        const translationDiv = document.createElement("div")
        translationDiv.className = "hn-dual-translation"
        translationDiv.style.cssText = `
          background: #f8f9fa;
          border-left: 3px solid #ff6600;
          padding: 12px;
          margin: 8px 0;
          font-size: 0.95em;
          color: #333;
          line-height: 1.6;
        `
        translationDiv.textContent = response.translation
        paragraph.after(translationDiv)
      }
    } catch (error) {
      console.error("Paragraph translation error:", error)
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

// 主组件：只在从 HN 打开时自动翻译
const AutoTranslator = () => {
  // "idle" | "translating" | "done"
  const [status, setStatus] = useState<"idle" | "translating" | "done">("idle")

  useEffect(() => {
    ;(async () => {
      const fromHN = await isFromHackerNews()
      if (!fromHN) return

      const article = detectArticle()
      if (!article) return

      setStatus("translating")
      try {
        await translateArticle(article)
        setStatus("done")
        // 2 秒后淡出提示
        setTimeout(() => setStatus("idle"), 2000)
      } catch (error) {
        console.error("Auto-translation error:", error)
        setStatus("idle")
      }
    })()
  }, [])

  if (status === "idle") return null

  return (
    <div
      style={{
        position: "fixed",
        bottom: "20px",
        right: "20px",
        padding: "8px 14px",
        borderRadius: "20px",
        background: status === "done" ? "#4caf50" : "#ff6600",
        color: "white",
        fontSize: "13px",
        fontFamily: "system-ui, -apple-system, sans-serif",
        boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
        zIndex: 10000,
        userSelect: "none",
        transition: "background 0.3s"
      }}
    >
      {status === "translating" ? "⏳ 正在翻译..." : "✓ 翻译完成"}
    </div>
  )
}

export default AutoTranslator
