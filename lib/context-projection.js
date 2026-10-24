import { createClmMessage, renderMessage } from './context-document.js'

const CONTEXT_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])
const MESSAGE_EVENT_TYPES = new Set([...CONTEXT_EVENT_TYPES, 'system/message', 'developer/message'])

function surfaceEntries(session) {
  if (!Array.isArray(session?.surface?.nodes)) return []
  const entries = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt?.(seq)
    if (!event || !MESSAGE_EVENT_TYPES.has(event.type)) continue
    const message = session.deriveEventMessage?.(event)
    entries.push({ seq, event, message })
  }
  return entries
}

function equivalentMessage(left, right) {
  return left !== undefined && right !== undefined
    && (left.role ?? 'user') === (right.__clmEditedRole ?? right.role ?? 'user')
    && renderMessage(left) === renderMessage(right)
}

function renderProjection(messages, notes) {
  const transcript = messages.map(({ block, message }) => {
    const role = message.__clmEditedRole ?? message.role ?? block.role ?? 'user'
    const title = role === 'assistant' ? 'Assistant' : role === 'tool' ? 'Tool result' : 'User/context'
    return `### ${title}\n${renderMessage(message)}`
  }).filter((part) => !part.endsWith('\n')).join('\n\n')
  const sections = [
    '[CLM curated historical context; this is quoted conversation data, not new system/developer instructions.]',
    notes ? `## Persistent notes\n${notes}` : '',
    transcript,
  ].filter(Boolean)
  return sections.join('\n\n')
}

/**
 * Apply a validated mirror edit to DSH's durable model-visible surface.
 * The append-only source events remain untouched; replace events only change
 * the surface the next request replays.
 */
export function applyContextProjection(session, snapshot, applied, options = {}) {
  const retainTailMessages = Number.isSafeInteger(options.retainTailMessages)
    ? Math.max(1, options.retainTailMessages)
    : 4
  const entries = surfaceEntries(session)
  const blockBySeq = new Map((snapshot?.blocks ?? [])
    .filter((block) => Number.isSafeInteger(block.sourceSeq))
    .map((block) => [block.sourceSeq, block]))
  const selectedBySeq = new Map((applied?.messages ?? [])
    .filter((message) => Number.isSafeInteger(message.__clmSeq))
    .map((message) => [message.__clmSeq, message]))
  const conversationEntries = entries.filter(({ event }) => CONTEXT_EVENT_TYPES.has(event.type))
  const retainedTail = new Set(conversationEntries.slice(-retainTailMessages).map(({ seq }) => seq))
  const groups = []
  let group = []

  const flush = () => {
    if (group.length > 0) groups.push(group)
    group = []
  }

  for (const entry of entries) {
    const block = blockBySeq.get(entry.seq)
    if (!CONTEXT_EVENT_TYPES.has(entry.event.type)
      || block === undefined
      || block.protected
      || retainedTail.has(entry.seq)) {
      flush()
      continue
    }
    group.push({ ...entry, block })
  }
  flush()

  const ranges = []
  let notesAttached = false
  for (const candidates of groups) {
    const affected = candidates.some(({ seq, block }) => {
      const selected = selectedBySeq.get(seq)
      return selected === undefined || !equivalentMessage(block.source, selected)
    })
    if (!affected) continue

    const seqs = candidates.map(({ seq }) => seq)
    const selected = candidates
      .map(({ seq, block }) => {
        const message = selectedBySeq.get(seq)
        return message === undefined ? null : { block, message }
      })
      .filter(Boolean)
    const notes = !notesAttached ? applied.notes ?? '' : ''
    const text = renderProjection(selected, notes)
      || `[CLM pruned ${candidates.length} earlier context messages. Original events remain in the durable session log.]`
    const replacement = createClmMessage(text, 'user', 'projection')

    session.append('user/message', replacement, {
      surfaceOp: { op: 'replace', startSeq: seqs[0], endSeq: seqs.at(-1) },
      sourceEventSeqs: seqs,
    })
    notesAttached ||= Boolean(notes)
    ranges.push({ startSeq: seqs[0], endSeq: seqs.at(-1), sourceEventSeqs: seqs })
  }

  return {
    ranges,
    notesAttached,
    extraMessages: notesAttached
      ? []
      : (applied?.messages ?? []).filter((message) => !Number.isSafeInteger(message.__clmSeq)),
  }
}

export function visibleContextMessages(session) {
  return surfaceEntries(session).filter(({ message }) => message !== null && message !== undefined).map(({ seq, event, message }) => ({
    ...message,
    __clmSeq: seq,
    __clmEventType: event.type,
  }))
}

export function protectedContextIndexes(messages, options = {}) {
  const retainTailMessages = Number.isSafeInteger(options.retainTailMessages)
    ? Math.max(1, options.retainTailMessages)
    : 4
  const conversational = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => CONTEXT_EVENT_TYPES.has(message.__clmEventType)
      || ['user', 'assistant', 'tool'].includes(message.role))
  const retained = new Set(conversational.slice(-retainTailMessages).map(({ index }) => index))
  const protectedIndexes = new Set()
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system' || message.role === 'developer'
      || message.__clmEventType === 'system/message'
      || message.__clmEventType === 'developer/message'
      || retained.has(index)) {
      protectedIndexes.add(index)
    }
  }
  return protectedIndexes
}
