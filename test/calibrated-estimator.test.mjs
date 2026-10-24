import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { calibrationFactor, estimateSessionTokens } from '../lib/calibrated-estimator.js'

test('CLM applies the context-trim p90 factor to TokenMeter estimates by route', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clm-calibration-'))
  const calibrationPath = join(dir, 'context-trim-calibration.json')
  try {
    await writeFile(calibrationPath, JSON.stringify({
      version: 1,
      routes: [
        { key: 'openai-codex:gpt-6-luna', samples: [1.2, 1.4, 1.3] },
        { key: 'other:model', samples: [3, 3, 3] },
      ],
    }))
    const session = { requestHeader: () => ({ config: { provider: 'openai-codex', model: 'gpt-6-luna' } }) }
    const tokenMeter = { measure: () => ({ totalTokens: 100, baseline: { kind: 'estimate' } }) }

    assert.equal(await calibrationFactor(calibrationPath, 'openai-codex:gpt-6-luna'), 1.4)
    assert.equal(await estimateSessionTokens(session, { tokenMeter, calibrationPath }), 140)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('CLM trusts provider-usage baselines and calibrates fallback estimates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clm-calibration-'))
  const calibrationPath = join(dir, 'context-trim-calibration.json')
  try {
    await writeFile(calibrationPath, JSON.stringify({
      version: 1,
      routes: [{ key: 'provider:model', samples: [1.2, 1.3, 1.4] }],
    }))
    const session = { requestHeader: () => ({ config: { provider: 'provider', model: 'model' } }) }
    assert.equal(await estimateSessionTokens(session, {
      tokenMeter: {
        measure: () => ({
          totalTokens: 123,
          baseline: { kind: 'usage', tokens: 100 },
          surfaceDeltaTokens: 23,
          surfaceTokens: 100,
        }),
      },
      calibrationPath,
    }), 133)
    assert.equal(await estimateSessionTokens(session, {
      calibrationPath,
      fallbackEstimate: () => 100,
    }), 140)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('CLM uses the TokenMeter provider-usage anchor when the persisted sample factor is stale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clm-calibration-'))
  const calibrationPath = join(dir, 'context-trim-calibration.json')
  try {
    await writeFile(calibrationPath, JSON.stringify({
      version: 1,
      routes: [{ key: 'provider:model', samples: [0.75, 0.76, 0.74] }],
    }))
    const session = { requestHeader: () => ({ config: { provider: 'provider', model: 'model' } }) }
    assert.equal(await estimateSessionTokens(session, {
      calibrationPath,
      tokenMeter: {
        measure: () => ({
          totalTokens: 120,
          baseline: { kind: 'usage', tokens: 100 },
          surfaceDeltaTokens: 20,
          surfaceTokens: 60,
        }),
      },
    }), 150)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
