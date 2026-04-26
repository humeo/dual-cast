type LogArgs = unknown[]

const isDebugLoggingEnabled = process.env.NODE_ENV !== "production"

export function createLogger(scope: string) {
  const prefix = `[DualCast:${scope}]`

  return {
    debug: (...args: LogArgs) => {
      if (isDebugLoggingEnabled) console.debug(prefix, ...args)
    },
    info: (...args: LogArgs) => {
      if (isDebugLoggingEnabled) console.info(prefix, ...args)
    },
    warn: (...args: LogArgs) => {
      if (isDebugLoggingEnabled) console.warn(prefix, ...args)
    },
    error: (...args: LogArgs) => {
      if (isDebugLoggingEnabled) console.error(prefix, ...args)
    }
  }
}
