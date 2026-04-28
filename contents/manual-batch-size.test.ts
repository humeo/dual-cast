import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

function readManualBatchSize(fileName: string) {
  const source = readFileSync(new URL(fileName, import.meta.url), "utf8")
  const match = source.match(/const MANUAL_BATCH_SIZE = (\d+)/)
  if (!match) {
    throw new Error(`Missing MANUAL_BATCH_SIZE in ${fileName}`)
  }
  return Number(match[1])
}

assert.equal(
  readManualBatchSize("./hn-enhancer.tsx"),
  10,
  "HN pages should default to 10 items per manual batch"
)

assert.equal(
  readManualBatchSize("./universal-translator.tsx"),
  10,
  "Universal pages should default to 10 items per manual batch"
)

console.log("Manual translation batch size defaults are 10")
