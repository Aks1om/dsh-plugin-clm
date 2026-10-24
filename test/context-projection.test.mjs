import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { renderContextDocument, applyContextDocument, createClmMessage } from '../lib/context-document.js'
import { protectedContextIndexes, visibleContextMessages } from '../lib/context-projection.js'
import { MirrorStore } from '../lib/mirror-store.js'

function message(role, id, text, source = { kind: role }) {
  return { id, role, source, content: [{ type: 'text', text }] }
}

function makeSession(workspaceRoot) {
  const events = new Map()
  const nodes = []
  let nextSeq = 1
  const session = {
    id: 'clm-integration-session',
    header: { id: 'clm-integration-session', cwd: workspaceRoot, agentPreset: 'standard' },
    surface: { nodes },
    eventAt: (seq) => events.get(seq),
    deriveEventMessage(event) {
      if (event.type === 'user/message') return event.data
      if (event.type === 'tool/result') return event.data.message
      if (event.type === 'system/message' || event.type === 'developer/message' || event.type === 'assistant/message') {
        return event.data.message
      }
      return null
    },
    deriveMessages() {
      return nodes.map((seq) => session.deriveEventMessage(events.get(seq))).filter(Boolean)
    },
    append(type, data, options = {}) {
      const seq = nextSeq++
      const event = { type, seq, data, ...options }
      events.set(seq, event)
      if (options.surfaceOp === 'append' || options.surfaceOp === undefined) {
        nodes.push(seq)
      } else if (options.surfaceOp?.op === 'replace') {
        const start = nodes.indexOf(options.surfaceOp.startSeq)
        const end = nodes.indexOf(options.surfaceOp.endSeq)
        assert.ok(start >= 0 && end >= start, 'surface replacement must target existing ordered nodes')
        nodes.splice(start, end - start + 1, seq)
      }
      return { seq }
    },
  }

  session.append('system/message', { message: message('system', 'sys', 'preserve system prompt') }, { surfaceOp: 'append' })
  session.append('user/message', message('user', 'old-user', 'obsolete request and details'), { surfaceOp: 'append' })
  session.append('assistant/message', { message: message('assistant', 'old-assistant', 'stale long answer') }, { surfaceOp: 'append' })
  session.append('tool/result', { message: message('tool', 'old-tool', 'very large obsolete tool output') }, { surfaceOp: 'append' })
  session.append('user/message', message('user', 'recent-user', 'keep the current task'), { surfaceOp: 'append' })
  session.append('assistant/message', { message: message('assistant', 'recent-assistant', 'keep the latest result') }, { surfaceOp: 'append' })
  return { session, events }
}

function makeContext() {
  const handlers = new Map()
  const context = {
    handlers,
    inject(names, callback) {
      const service = names[0]
      if (service === 'systemPrompt') callback({ systemPrompt: { context() {} } })
      if (service === 'tools') callback({ tools: { register() {} } })
      if (service === 'commands') callback({ commands: { register() {} } })
    },
    on(name, handler) {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    logger: { info() {}, warn() {} },
  }
  return context
}

test('edited mirror becomes a durable DSH surface replacement and leaves append-only source events intact', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-clm-projection-'))
  try {
    const { session, events } = makeSession(workspace)
    const context = makeContext()
    apply(context, { defaultEnabled: true, retainTailMessages: 2 })

    await context.handlers.get('agent/created')({ agent: { session }, source: 'startup' })
    const mirror = MirrorStore.forSession(session.id, workspace)
    const originalSurface = [...session.surface.nodes]
    const canonical = renderContextDocument(
      visibleContextMessages(session),
      {
        documentSeed: session.id,
        sessionId: session.id,
        protectedIndexes: protectedContextIndexes(visibleContextMessages(session), { retainTailMessages: 2 }),
      },
    )
    const kept = canonical.blocks.filter((block) => ![2, 3, 4].includes(block.sourceSeq))
    const edited = [canonical.text.split('\n')[0], '# CLM edited test mirror', ...kept.map((block) => `${block.header}\n${block.body}`)].join('\n\n')
    await writeFile(mirror.filePath, edited, 'utf8')

    await context.handlers.get('session/event')(session, { type: 'turn/end' })
    assert.equal(await readFile(mirror.filePath, 'utf8'), edited, 'turn-end sync must preserve the model-edited mirror')

    const decision = await context.handlers.get('agent/pre-step')(
      { agent: { session }, messages: [], signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    )
    assert.equal(decision.kind, 'enter')

    const projected = session.deriveMessages()
    const visibleText = projected.map((item) => item.content.map((part) => part.text ?? '').join('\n')).join('\n')
    assert.match(visibleText, /preserve system prompt/u)
    assert.match(visibleText, /keep the current task/u)
    assert.match(visibleText, /keep the latest result/u)
    assert.doesNotMatch(visibleText, /obsolete request|stale long answer|very large obsolete tool output/u)
    assert.equal(session.surface.nodes.length, 4, 'the old range is replaced by one curated context message')
    assert.deepEqual(originalSurface.slice(0, 1), session.surface.nodes.slice(0, 1), 'system prompt remains at the surface head')
    assert.ok(events.has(originalSurface[1]) && events.has(originalSurface[2]) && events.has(originalSurface[3]), 'source events remain in the append-only log')
    assert.ok(session.surface.nodes.some((seq) => events.get(seq)?.surfaceOp?.op === 'replace'))
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('mirror edits cannot alter, remove, duplicate, or stale protected/system blocks', () => {
  const messages = [
    { ...message('system', 'sys', 'system instructions'), __clmSeq: 1, __clmEventType: 'system/message' },
    { ...message('user', 'request', 'latest user request'), __clmSeq: 2, __clmEventType: 'user/message' },
  ]
  const snapshot = renderContextDocument(messages, {
    documentSeed: 'protected-session',
    sessionId: 'protected-session',
    protectedIndexes: new Set([0, 1]),
  })
  const systemBlock = snapshot.blocks.find((block) => block.role === 'system')
  assert.ok(systemBlock)
  const changedSystem = snapshot.text.replace('system instructions', 'overwritten system instructions')
  assert.equal(applyContextDocument(changedSystem, snapshot).reason, 'protected-block-modified')

  const withoutSystem = [
    snapshot.text.split('\n')[0],
    '# edited mirror',
    ...snapshot.blocks.filter((block) => block.id !== systemBlock.id).map((block) => `${block.header}\n${block.body}`),
  ].join('\n\n')
  assert.equal(applyContextDocument(withoutSystem, snapshot).reason, 'protected-block-removed')
  assert.equal(applyContextDocument(`${snapshot.text}\n\n${systemBlock.header}\n${systemBlock.body}`, snapshot).reason, 'duplicate-block-id')
  assert.equal(applyContextDocument(snapshot.text.replace('baseline=', 'baseline=0'), snapshot).reason, 'stale-document')
})

test('CLM context notes stay mirrored so protected-tail indexes match the visible surface', () => {
  const messages = [
    { ...message('user', 'first', 'first conversation message'), __clmSeq: 1, __clmEventType: 'user/message' },
    { ...createClmMessage('remember the active goal', 'user', 'context'), __clmSeq: 2, __clmEventType: 'user/message' },
    { ...message('user', 'latest', 'latest conversation message'), __clmSeq: 3, __clmEventType: 'user/message' },
  ]
  const snapshot = renderContextDocument(messages, {
    documentSeed: 'notes-session',
    sessionId: 'notes-session',
    protectedIndexes: protectedContextIndexes(messages, { retainTailMessages: 1 }),
  })
  assert.deepEqual(snapshot.blocks.map((block) => block.sourceSeq), [1, 2, 3])
  assert.equal(snapshot.blocks[0].protected, false)
  assert.equal(snapshot.blocks[1].protected, false)
  assert.equal(snapshot.blocks[2].protected, true)
})
