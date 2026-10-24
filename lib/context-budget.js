const DEFAULT_FRACTION = 0.75
const DEFAULT_FALLBACK_TOKENS = 64_000
const DEFAULT_RESERVE_TOKENS = 4_096

export function normalizeContextWindowFraction(value) {
  return Number.isFinite(value) && value >= 0.25 && value <= 0.9
    ? value
    : DEFAULT_FRACTION
}

export function resolveContextBudget(options = {}) {
  const reserveTokens = Number.isSafeInteger(options.reserveTokens) && options.reserveTokens >= 0
    ? options.reserveTokens
    : DEFAULT_RESERVE_TOKENS
  const contextWindowFraction = normalizeContextWindowFraction(options.contextWindowFraction)
  const fallbackBudgetTokens = Number.isSafeInteger(options.fallbackBudgetTokens) && options.fallbackBudgetTokens > 0
    ? options.fallbackBudgetTokens
    : DEFAULT_FALLBACK_TOKENS
  const contextWindow = options.contextWindow

  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    return {
      source: 'fallback',
      contextWindow: undefined,
      contextWindowFraction,
      budgetLimitTokens: Math.max(8_192, fallbackBudgetTokens - reserveTokens),
      targetBudgetTokens: fallbackBudgetTokens,
      reserveTokens,
    }
  }

  const budgetLimitTokens = Math.max(1, Math.min(contextWindow, Math.floor(contextWindow * contextWindowFraction)))
  const effectiveReserveTokens = Math.min(reserveTokens, Math.max(0, contextWindow - budgetLimitTokens))
  return {
    source: 'model',
    contextWindow,
    contextWindowFraction,
    budgetLimitTokens,
    targetBudgetTokens: budgetLimitTokens + effectiveReserveTokens,
    reserveTokens: effectiveReserveTokens,
  }
}
