import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EXTENSION_PATH = path.join(__dirname, "build/chrome-mv3-prod")
const HN_URL = "https://news.ycombinator.com/item?id=dualcast-e2e"
const TEST_TIMEOUT_MS = 120_000
const CHROME_CANDIDATES = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].filter(Boolean)

const HN_FIXTURE = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>HN E2E Test | Hacker News</title>
    <style>
      body { font-family: Verdana, Geneva, sans-serif; font-size: 10pt; }
      .titleline > a { color: #000; text-decoration: none; }
      .subtext { color: #828282; font-size: 7pt; }
      .commtext { max-width: 760px; line-height: 1.35; }
    </style>
  </head>
  <body>
    <center>
      <table id="hnmain" border="0" cellpadding="0" cellspacing="0" width="85%">
        <tr class="athing" id="story-1">
          <td class="title">
            <span class="titleline">
              <a href="https://example.com/article">Open source maintainers build a faster browser extension workflow</a>
            </span>
          </td>
        </tr>
        <tr>
          <td class="subtext">
            <span class="subtext">42 points by dualcast-test 1 hour ago | hide | 12 comments</span>
          </td>
        </tr>
        <tr>
          <td>
            <div class="toptext">Ask HN: What is the most reliable way to translate technical discussions while preserving context?</div>
          </td>
        </tr>
        <tr class="athing comtr" id="comment-row-1">
          <td>
            <div class="commtext" id="first-comment">I tried a similar translation workflow last week, and the useful part was keeping the original sentence directly above the translated text.</div>
          </td>
        </tr>
        <tr>
          <td><div id="lazy-spacer" style="height: 14000px"></div></td>
        </tr>
        <tr class="athing comtr" id="comment-row-2">
          <td>
            <div class="commtext" id="deep-comment">The important part about lazy translation is that comments far below the fold should not spend tokens until the reader scrolls to them.</div>
          </td>
        </tr>
      </table>
    </center>
  </body>
</html>`

function readEnvLocal() {
  const envPath = path.join(__dirname, ".env.local")
  if (!fs.existsSync(envPath)) {
    throw new Error(".env.local is required for E2E tests")
  }

  const values = {}
  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values[key] = value
  }

  const apiKey =
    values["openai-api-key"] ||
    values.OPENAI_API_KEY ||
    values.api_key ||
    values.API_KEY
  const model = values.model || values.OPENAI_MODEL
  const baseUrl = values.base_url || values.OPENAI_BASE_URL

  if (!apiKey) throw new Error(".env.local is missing openai-api-key")
  if (!model) throw new Error(".env.local is missing model")
  if (!baseUrl) throw new Error(".env.local is missing base_url")

  return { apiKey, model, baseUrl }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function hasCjk(text) {
  return /[\u3400-\u9fff]/.test(text || "")
}

async function getExtensionId(context) {
  let serviceWorker = context.serviceWorkers()[0]
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker", {
      timeout: 10_000
    })
  }

  const match = serviceWorker.url().match(/^chrome-extension:\/\/([^/]+)\//)
  if (!match) {
    throw new Error(
      `Could not determine extension id from ${serviceWorker.url()}`
    )
  }
  return match[1]
}

async function configureExtension(extensionPage, config) {
  await extensionPage.evaluate(
    ({ apiKey, baseUrl, model }) =>
      new Promise((resolve, reject) => {
        chrome.storage.local.set(
          {
            apiKey,
            apiProvider: "openai",
            apiBaseUrl: baseUrl,
            apiModel: model,
            openAIBatchSize: 4,
            showTranslations: true
          },
          () => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message))
              return
            }
            chrome.storage.sync.set({ targetLang: "zh" }, () => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message))
                return
              }
              resolve()
            })
          }
        )
      }),
    config
  )
}

async function getTabId(extensionPage, url) {
  return extensionPage.evaluate(
    (targetUrl) =>
      new Promise((resolve, reject) => {
        chrome.tabs.query({ url: targetUrl }, (tabs) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message))
            return
          }
          resolve(tabs[0]?.id ?? null)
        })
      }),
    url
  )
}

async function sendTranslate(extensionPage, tabId) {
  await extensionPage.evaluate(
    (targetTabId) =>
      new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(
          targetTabId,
          { type: "TRANSLATE_PAGE" },
          (res) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message))
              return
            }
            if (!res?.success) {
              reject(
                new Error("content script did not acknowledge TRANSLATE_PAGE")
              )
              return
            }
            resolve()
          }
        )
      }),
    tabId
  )
}

async function getTranslationState(extensionPage) {
  return extensionPage.evaluate(
    () =>
      new Promise((resolve, reject) => {
        chrome.storage.local.get(["translationState"], (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message))
            return
          }
          resolve(result.translationState ?? null)
        })
      })
  )
}

async function main() {
  const env = readEnvLocal()
  assert(fs.existsSync(EXTENSION_PATH), "Run `bun run build` before E2E tests")

  const consoleMessages = []
  const userDataDir = path.join(
    "/tmp",
    `dualcast-hn-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )

  const executablePath = CHROME_CANDIDATES.find((candidate) =>
    fs.existsSync(candidate)
  )

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      "--no-sandbox"
    ],
    viewport: { width: 1280, height: 800 }
  })

  try {
    await context.route("https://news.ycombinator.com/**", (route) => {
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: HN_FIXTURE
      })
    })

    const extensionId = await getExtensionId(context)
    const extensionPage = await context.newPage()
    await extensionPage.goto(`chrome-extension://${extensionId}/popup.html`)
    await configureExtension(extensionPage, env)

    const hnPage = await context.newPage()
    hnPage.on("console", (msg) => {
      consoleMessages.push(`${msg.type()}: ${msg.text()}`)
    })
    await hnPage.goto(HN_URL, { waitUntil: "domcontentloaded" })
    await hnPage.waitForSelector(".titleline > a")

    const tabId = await getTabId(extensionPage, HN_URL)
    assert(tabId, "Could not find controlled Hacker News tab")

    await sendTranslate(extensionPage, tabId)

    await hnPage.waitForFunction(
      () =>
        Boolean(
          document.querySelector("tr.athing + tr .hn-dual-translation")
        ) &&
        Boolean(
          document.querySelector("#first-comment .hn-dual-comment-translation")
        ),
      null,
      { timeout: TEST_TIMEOUT_MS }
    )

    const firstPass = await hnPage.evaluate(() => ({
      title:
        document
          .querySelector("tr.athing + tr .hn-dual-translation")
          ?.textContent?.trim() || "",
      firstComment:
        document
          .querySelector("#first-comment .hn-dual-comment-translation")
          ?.textContent?.trim() || "",
      deepComment:
        document
          .querySelector("#deep-comment .hn-dual-comment-translation")
          ?.textContent?.trim() || ""
    }))

    assert(hasCjk(firstPass.title), "HN title was not translated to Chinese")
    assert(
      hasCjk(firstPass.firstComment),
      "Visible HN comment was not translated to Chinese"
    )
    assert(
      firstPass.deepComment === "",
      "Deep offscreen comment translated before scrolling"
    )

    const progressiveState = await getTranslationState(extensionPage)
    assert(
      progressiveState?.status === "translating" &&
        progressiveState.done > 0 &&
        progressiveState.done < progressiveState.total,
      `Expected progressive translation state, got ${JSON.stringify(progressiveState)}`
    )

    await hnPage.locator("#deep-comment").scrollIntoViewIfNeeded()
    await hnPage.waitForFunction(
      () =>
        Boolean(
          document.querySelector("#deep-comment .hn-dual-comment-translation")
        ),
      null,
      { timeout: TEST_TIMEOUT_MS }
    )

    const finalPass = await hnPage.evaluate(() => ({
      deepComment:
        document
          .querySelector("#deep-comment .hn-dual-comment-translation")
          ?.textContent?.trim() || "",
      translatedMarkers: document.querySelectorAll("[data-hn-dual-translated]")
        .length,
      translationBlocks: document.querySelectorAll(
        ".hn-dual-translation, .hn-dual-comment-translation, .hn-dual-toptext-translation"
      ).length
    }))

    assert(
      hasCjk(finalPass.deepComment),
      "Scrolled HN comment was not translated to Chinese"
    )
    assert(
      finalPass.translatedMarkers >= 4 && finalPass.translationBlocks >= 4,
      `Expected all HN items translated, got ${JSON.stringify(finalPass)}`
    )

    const noisyProductionLogs = consoleMessages.filter((line) =>
      /\b(HN Dual|DualCast|Translation error|Readability error|Paragraph translation error)\b/.test(
        line
      )
    )
    assert(
      noisyProductionLogs.length === 0,
      `Production content scripts emitted console logs:\n${noisyProductionLogs.join("\n")}`
    )

    console.log(
      "HN E2E passed: title, visible comment, progressive state, scroll lazy comment"
    )
  } finally {
    await context.close()
    fs.rmSync(userDataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
