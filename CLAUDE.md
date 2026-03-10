# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install          # Install dependencies
bun run dev          # Start dev mode (outputs to build/chrome-mv3-dev)
bun run build        # Production build (outputs to build/chrome-mv3-prod)
bun run package      # Package the extension for distribution
```

After `bun run dev`, load the unpacked extension from `build/chrome-mv3-dev` in Chrome's extension manager (chrome://extensions/ → Developer mode → Load unpacked).

## Architecture

This is a [Plasmo](https://docs.plasmo.com/) browser extension (Chrome MV3) with TypeScript + React. Plasmo handles bundling, manifest generation, and hot-reloading.

### Extension Components

**`background/index.ts`** — Service worker. Owns all translation API calls. Listens for `TRANSLATE` messages from content scripts, deduplicates via in-memory cache (`Map<string, string>`), and batches requests (up to 20 texts, 100ms delay) before calling the API. DeepL uses a single batch HTTP request with multiple `text` params; OpenAI processes items serially. Settings (`apiKey`, `apiProvider`) are read from `chrome.storage.sync`.

**`contents/hn-enhancer.tsx`** — Content script injected only on `news.ycombinator.com`. Listens for `TRANSLATE_PAGE` from the popup, then walks the DOM to translate `.titleline > a` (titles), `.toptext` (Ask HN post bodies), and `.commtext` (comments). Translated elements are marked with `data-hn-dual-translated` to prevent re-translation. Translations are inserted as sibling `div.hn-dual-*` elements.

**`contents/universal-translator.tsx`** — Content script injected on all non-HN URLs. Renders a floating 🌐 button (bottom-right, fixed) when `@mozilla/readability` detects article content (≥200 chars). On click, extracts article paragraphs from common selectors and translates them paragraph-by-paragraph, inserting `div.hn-dual-translation` after each `<p>`.

**`popup.tsx`** — Settings UI. Saves `apiKey` and `apiProvider` to `chrome.storage.sync`. Also has a "translate current page" button that sends `TRANSLATE_PAGE` to the active tab's content script (HN only).

### Message Flow

```
popup / content script
    → chrome.runtime.sendMessage({ type: "TRANSLATE", text, targetLang })
    → background/index.ts (batches, checks cache, calls API)
    → returns { translation: string }
```

### Translation Providers

- **DeepL** (recommended): Detects free vs. pro API by checking if key ends with `:fx`. Uses `api-free.deepl.com` or `api.deepl.com` accordingly. Supports batching multiple texts in one HTTP request.
- **OpenAI**: Uses `gpt-4o-mini`, processes one text at a time despite being in the batch queue.

### Key Conventions

- CSS class names for injected translations: `hn-dual-translation`, `hn-dual-comment-translation`, `hn-dual-toptext-translation`
- DOM attribute to mark already-translated elements: `data-hn-dual-translated="true"`
- HN brand color used throughout UI: `#ff6600`
- `tsconfig.json` uses `~*` path alias mapped to the project root
