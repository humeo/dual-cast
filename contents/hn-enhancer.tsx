import type { PlasmoCSConfig } from "plasmo"
import { useEffect } from "react"

import { createLogger } from "~utils/logger"

export const config: PlasmoCSConfig = {
  matches: ["https://news.ycombinator.com/*"],
  all_frames: false
}

const logger = createLogger("hn-enhancer")

// 控制翻译内容的可见性
const VISIBILITY_STYLE_ID = "hn-dual-visibility"
const HIDE_CSS = `.hn-dual-translation, .hn-dual-comment-translation, .hn-dual-toptext-translation { display: none !important; }`
const MANUAL_CONTROL_ID = "hn-dual-manual-control"
const MANUAL_BATCH_SIZE = 5

interface ManualQueueItem {
  el: HTMLElement
  type: "title" | "toptext" | "comment"
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

// 主组件
const HNEnhancer = () => {
  useEffect(() => {
    logger.debug("Enhancing Hacker News page")

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
        reportStopped(manualDone, manualTotal)
        updateManualControl()
        sendResponse({ success: true })
      }
      if (message.type === "TOGGLE_TRANSLATIONS") {
        applyVisibility(message.show)
      }
      if (message.type === "GET_ARTICLE_TEXT") {
        const titleEls = Array.from(document.querySelectorAll(".titleline > a"))
        const titles = titleEls
          .map((el) => el.textContent?.trim())
          .filter(Boolean)
          .join("\n")
        const toptext =
          document.querySelector(".toptext")?.textContent?.trim() || ""
        const comments = Array.from(document.querySelectorAll(".commtext"))
          .map((el) => el.textContent?.trim())
          .filter((t) => t && t.length > 20)
          .join("\n\n")
        const text = [titles, toptext, comments]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 8000)
        sendResponse({ title: document.title, text })
      }
      return true
    })
  }, [])

  return null
}

// 向 popup 报告进度，同时持久化到 storage 供 popup 重新打开时恢复
function reportProgress(done: number, total: number) {
  chrome.runtime
    .sendMessage({ type: "GET_TAB_ID" })
    .then((res) => {
      chrome.storage.local.set({
        translationState: {
          status: "translating",
          done,
          total,
          tabId: res?.tabId
        }
      })
    })
    .catch(() => {})
  chrome.runtime
    .sendMessage({ type: "TRANSLATION_PROGRESS", done, total })
    .catch(() => {})
}

function reportComplete(total: number) {
  chrome.storage.local.remove("translationState")
  chrome.runtime
    .sendMessage({ type: "TRANSLATION_COMPLETE", total })
    .catch(() => {})
}

function reportStopped(_done: number, _total: number) {
  chrome.storage.local.remove("translationState")
  chrome.runtime.sendMessage({ type: "TRANSLATION_STOPPED" }).catch(() => {})
}

// 翻译取消标志
let shouldStop = false

let manualTargetLang = "zh"
let manualQueue: ManualQueueItem[] = []
let manualTotal = 0
let manualDone = 0
let manualInFlight = false

async function translateElement(
  el: HTMLElement,
  type: "title" | "toptext" | "comment"
) {
  if (shouldStop || el.getAttribute("data-hn-dual-translated") === "true")
    return
  el.setAttribute("data-hn-dual-translated", "true")

  const text = el.textContent || ""
  try {
    const response = await chrome.runtime.sendMessage({
      type: "TRANSLATE",
      text,
      targetLang: manualTargetLang
    })
    if (!response.translation) return

    const div = document.createElement("div")
    if (type === "title") {
      div.className = "hn-dual-translation"
      div.style.cssText =
        "color:#666;font-size:0.9em;margin-top:1px;margin-bottom:6px;line-height:1.4;padding:0;"
      div.textContent = response.translation
      const titleRow = el.closest(".athing")
      if (titleRow?.nextElementSibling) {
        const subtext = titleRow.nextElementSibling.querySelector(".subtext")
        if (subtext) subtext.parentElement?.insertBefore(div, subtext)
      }
    } else if (type === "toptext") {
      div.className = "hn-dual-toptext-translation"
      div.style.cssText =
        "background:#f6f6ef;padding:6px 8px 8px;margin-top:2px;margin-bottom:8px;border-left:2px solid #ff6600;color:#333;font-size:0.95em;line-height:1.5;"
      div.textContent = response.translation
      el.after(div)
    } else {
      div.className = "hn-dual-comment-translation"
      div.style.cssText =
        "background:#f6f6ef;padding:6px 8px 8px;margin-top:2px;margin-bottom:8px;border-left:2px solid #ff6600;color:#333;font-size:0.95em;line-height:1.5;"
      div.textContent = response.translation
      el.appendChild(div)
    }
  } catch (error) {
    logger.error("Translation error", error)
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
    "right:16px",
    "bottom:16px",
    "z-index:2147483647",
    "display:flex",
    "gap:8px",
    "align-items:center",
    "padding:8px",
    "border:1px solid rgba(255,102,0,0.35)",
    "border-radius:8px",
    "background:#fffdf4",
    "box-shadow:0 6px 18px rgba(0,0,0,0.12)",
    "font-family:Verdana,Geneva,sans-serif",
    "font-size:12px",
    "color:#333"
  ].join(";")

  const status = document.createElement("span")
  status.dataset.role = "status"
  status.style.cssText = "min-width:58px;color:#666"

  const nextButton = document.createElement("button")
  nextButton.dataset.role = "next"
  nextButton.type = "button"
  nextButton.style.cssText = [
    "border:0",
    "border-radius:6px",
    "background:#ff6600",
    "color:#fff",
    "padding:6px 10px",
    "font:inherit",
    "font-weight:600",
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
    "border:1px solid #ddd",
    "border-radius:6px",
    "background:#fff",
    "color:#666",
    "padding:6px 9px",
    "font:inherit",
    "cursor:pointer"
  ].join(";")
  stopButton.addEventListener("click", () => {
    shouldStop = true
    reportStopped(manualDone, manualTotal)
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
    await translateElement(item.el, item.type)
    translatedInBatch++
  }

  manualInFlight = false
  if (shouldStop) {
    reportStopped(manualDone, manualTotal)
  } else if (manualQueue.length === 0) {
    reportComplete(manualTotal)
  }
  updateManualControl()
}

// 翻译当前页面（手动批次模式）
async function translateCurrentPage() {
  logger.debug("Starting manual batch page translation")

  const settings = await chrome.storage.sync.get(["targetLang"])
  manualTargetLang = settings.targetLang || "zh"

  // 收集所有待翻译元素
  const titleLinks = Array.from(
    document.querySelectorAll(".titleline > a:not([data-hn-dual-translated])")
  ).filter((el) => (el.textContent || "").trim().length >= 5) as HTMLElement[]

  const topTexts = Array.from(
    document.querySelectorAll(".toptext:not([data-hn-dual-translated])")
  ).filter((el) => (el.textContent || "").trim().length >= 10) as HTMLElement[]

  const comments = Array.from(
    document.querySelectorAll(".commtext:not([data-hn-dual-translated])")
  ).filter((el) => (el.textContent || "").trim().length >= 10) as HTMLElement[]

  manualQueue = [
    ...titleLinks.map((el) => ({ el, type: "title" as const })),
    ...topTexts.map((el) => ({ el, type: "toptext" as const })),
    ...comments.map((el) => ({ el, type: "comment" as const }))
  ]
  manualTotal = manualQueue.length
  manualDone = 0
  manualInFlight = false
  shouldStop = false

  logger.debug("Found translatable HN elements", {
    titles: titleLinks.length,
    topTexts: topTexts.length,
    comments: comments.length,
    total: manualTotal
  })

  if (manualTotal === 0) {
    reportComplete(0)
    updateManualControl()
    return
  }

  reportProgress(0, manualTotal)
  updateManualControl()
  await translateNextManualBatch()
}

export default HNEnhancer
