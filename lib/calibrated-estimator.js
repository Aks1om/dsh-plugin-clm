import { readFile } from 'node:fs/promises'

const CALIBRATION_MIN_SAMPLES = 3
const CALIBRATION_MIN_FACTOR = 1
const CHARS_PER_TOKEN = 4
const TOOLS_OVERHEAD = 4

function estimateEnvelopeTokens(header) {
  const tools = header?.tools
  if (!Array.isArray(tools) || tools.length === 0) return 0
  return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + TOOLS_OVERHEAD
}

/**
 * Read the context-trim route calibration and use its p90 factor, matching the
 * source plugin's conservative policy. Missing, partial, or malformed data is
 * treated as an uncalibrated route.
 */
export async function calibrationFactor(calibrationPath, routeKey) {
  if (!calibrationPath || !routeKey) return CALIBRATION_MIN_FACTOR
  try {
    const snapshot = JSON.parse(await readFile(calibrationPath, 'utf8'))
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.routes)) return CALIBRATION_MIN_FACTOR
    const entry = snapshot.routes.find((route) => route?.key === routeKey)
    const samples = Array.isArray(entry?.samples)
      ? entry.samples.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
      : []
    if (samples.length < CALIBRATION_MIN_SAMPLES) return CALIBRATION_MIN_FACTOR
    const p90 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.9) - 1)]
    return Math.max(CALIBRATION_MIN_FACTOR, p90)
  } catch {
    return CALIBRATION_MIN_FACTOR
  }
}

/**
 * Price the current session using DSH's structural TokenMeter and the route's
 * learned density. When the meter already anchors its total to provider usage,
 * trust that real measurement rather than applying the learned factor twice.
 */
export async function estimateSessionTokens(session, options = {}) {
  const route = session?.requestHeader?.()?.config
  const routeKey = typeof route?.provider === 'string' && typeof route?.model === 'string'
    ? `${route.provider}:${route.model}`
    : undefined
  const factor = await calibrationFactor(options.calibrationPath, routeKey)

  try {
    const measurement = options.tokenMeter?.measure?.(session)
    const tokens = measurement?.totalTokens
    if (Number.isFinite(tokens) && tokens >= 0) {
      if (measurement.baseline?.kind === 'usage') {
        const baselineTokens = measurement.baseline.tokens
        const deltaTokens = measurement.surfaceDeltaTokens
        if (Number.isFinite(baselineTokens) && Number.isFinite(deltaTokens)) {
          const anchorSurface = measurement.surfaceTokens - deltaTokens
          const heuristicPrompt = anchorSurface + estimateEnvelopeTokens(session?.requestHeader?.())
          const impliedFactor = heuristicPrompt > 0
            ? Math.max(CALIBRATION_MIN_FACTOR, baselineTokens / heuristicPrompt)
            : CALIBRATION_MIN_FACTOR
          const effectiveFactor = Math.max(factor, impliedFactor)
          return Math.max(0, Math.ceil(baselineTokens + deltaTokens * effectiveFactor))
        }
        return Math.ceil(tokens)
      }
      return Math.ceil(tokens * factor)
    }
  } catch {
    // Fall through to the CLM-local estimate when TokenMeter cannot price this session.
  }

  const fallbackTokens = options.fallbackEstimate?.() ?? 0
  return Math.ceil(fallbackTokens * factor)
}
