# Repository Guidelines

## Project Structure & Module Organization

This is a Plasmo Chrome MV3 extension built with TypeScript and React.

- `popup.tsx`: extension popup UI, settings, usage, history, and page actions.
- `background/index.ts`: service worker for translation, summarization, batching, caching, and usage stats.
- `contents/hn-enhancer.tsx`: Hacker News-specific content script.
- `contents/universal-translator.tsx`: general article/social-page translator content script.
- `assets/`: extension icons and README images.
- `.github/workflows/submit.yml`: manual Web Store submission workflow.
- Generated outputs such as `build/`, `.plasmo/`, `node_modules/`, and `*.tsbuildinfo` stay out of source review.

## Build, Test, and Development Commands

Use Bun for all JavaScript/TypeScript dependency and script work.

```bash
bun install              # install dependencies from bun.lock
bun run dev              # start Plasmo dev mode; outputs build/chrome-mv3-dev
bun run build            # production build; outputs build/chrome-mv3-prod
bun run package          # create the production extension package
bun run test:e2e         # build and run HN OpenAI-compatible E2E
bunx tsc --noEmit        # type-check without writing files
bunx prettier --check <files>  # check touched files
```

After `bun run dev`, load `build/chrome-mv3-dev` from `chrome://extensions/` with Developer mode enabled.

## Coding Style & Naming Conventions

Prettier is configured in `.prettierrc.mjs`: 2 spaces, 80-column print width, double quotes, no semicolons, no trailing commas, and sorted imports. Keep React components in PascalCase, local values in camelCase, and injected CSS classes prefixed with `hn-dual-`. Preserve the `~*` path alias when root-relative imports are clearer.

## Testing Guidelines

Before submitting changes, run `bunx tsc --noEmit`, Prettier on touched files, and `bun run build`. Use `bun run test:e2e` for the Hacker News LLM path; it reads `.env.local` and verifies title, comment, progressive, and scroll-triggered translation. Smoke-test non-HN article/social pages through `contents/universal-translator.tsx`. When adding tests, prefer focused `*.test.ts` or `*.test.tsx` files near the module under test.

## Commit & Pull Request Guidelines

Recent history uses short imperative subjects such as `Fix queue drain...` and `Add OpenAI batch translation...`. Keep commits scoped and under roughly 72 characters when possible. PRs should describe user-visible behavior, list verification commands, mention Chrome manual test coverage, link issues, and include screenshots or short recordings for popup or injected-page UI changes.

## Security, Configuration & Agent Notes

Never commit API keys, local `.key` files, screenshots with secrets, or generated extension archives. Store user settings in Chrome storage rather than source constants. Development logs go through the shared logger; production extension builds must not emit console logs. If Python tooling is added, manage it with `uv`.
