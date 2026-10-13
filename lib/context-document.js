import { createHash, randomUUID } from 'node:crypto';

export const DOCUMENT_VERSION = 1;

export const META_RE = /^\[\[LIVE_CONTEXT version=(\d+) revision=(\d+) document=([a-f0-9]{16,64})\s*baseline=([a-f0-9]{12,64})\]\](?:\r?\n|$)/;

const STRUCTURAL_LINE_RE = /^(\\*)(\[\[(?:CTX_TURN|LIVE_CONTEXT) )/gm;

export function escapeStructuralLines(body) {
  return body.replace(STRUCTURAL_LINE_RE, (_match, slashes, start) => `\\${slashes}${start}`);
}

export function unescapeStructuralLines(body) {
  return body.replace(STRUCTURAL_LINE_RE, (_match, slashes, start) =>
    slashes.length > 0 ? `${slashes.slice(1)}${start}` : `${slashes}${start}`
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeJson(item)])
    );
  }
  return value;
}

export function canonicalMessage(message) {
  return JSON.stringify(normalizeJson(message));
}

export function digestMessages(messages) {
  const hash = createHash('sha256');
  for (const message of messages) {
    hash.update(canonicalMessage(message));
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return String(part ?? '');
      if (part.type === 'text' && typeof part.text === 'string') return part.text;
      if (part.type === 'reasoning' && typeof part.text === 'string') {
        return `[thinking]\n${part.text}`;
      }
      if (part.type === 'thinking' && typeof part.thinking === 'string') {
        return `[thinking]\n${part.thinking}`;
      }
      if (part.type === 'toolCall' || part.type === 'tool-call') {
        const name = typeof part.name === 'string' ? part.name : 'tool';
        const args = part.arguments ?? part.input ?? {};
        const argsText = typeof args === 'string' ? args : JSON.stringify(normalizeJson(args));
        return `[tool call: ${name}]\n${argsText}`;
      }
      if (part.type === 'toolResult' || part.type === 'tool-result') {
        const out = typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? '');
        return `[tool result: ${part.toolCallId || part.id || ''}]\n${out}`;
      }
      if (part.type === 'image') {
        const mimeType = part.mimeType || part.source?.mediaType || 'image/png';
        return `[image: ${mimeType}; data omitted]`;
      }
      return JSON.stringify(normalizeJson(part));
    })
    .filter(Boolean)
    .join('\n');
}

export function renderMessage(message) {
  if (!message || typeof message !== 'object') return '';
  const parts = [];
  const content = textFromContent(message.content);
  if (content) parts.push(content);

  // Manejar llamadas a herramientas estándar (OpenAI style)
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const toolCall of toolCalls) {
    if (!toolCall || typeof toolCall !== 'object') continue;
    const fn = toolCall.function || {};
    parts.push(`[tool call: ${fn.name || 'tool'}]\n${fn.arguments || ''}`);
  }

  // Manejar mensajes de rol tool
  const toolCallId = message.toolCallId || message.tool_call_id || message.source?.callId;
  if (message.role === 'tool' && toolCallId) {
    parts.unshift(`[tool_call_id: ${toolCallId}]`);
  }

  return parts.join('\n\n').trim();
}

function blockId(message, index) {
  const digest = createHash('sha256').update(canonicalMessage(message)).digest('hex').slice(0, 12);
  return `${index + 1}-${digest}`;
}

function documentId(baselineDigest, revision) {
  return createHash('sha256')
    .update(`dsh-live-context:${DOCUMENT_VERSION}:${revision}:${baselineDigest}`)
    .digest('hex');
}

/**
 * Extrae el bloque de notas persistentes (role=notes o id=1-system-notes) de un documento LIVE_CONTEXT.md existente.
 */
export function extractNotesFromDocument(text) {
  if (!text || typeof text !== 'string') return null;

  // Buscar bloques CTX_TURN con role=notes o id=*notes*
  const anyBlockRe = /^\[\[CTX_TURN\s+[^\]]*role=([A-Za-z0-9_-]+)\s+id=([A-Za-z0-9_-]+)\s+protected=(true|false)\]\]\s*$/gm;
  const matches = [...text.matchAll(anyBlockRe)];

  if (matches.length > 0) {
    const noteBlocks = [];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const role = m[1];
      const id = m[2];
      const start = (m.index ?? 0) + m[0].length;
      const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
      if (role === 'notes' || id.includes('notes') || id === 'init') {
        const body = text.slice(start, end).trim();
        if (body) noteBlocks.push(body);
      }
    }
    if (noteBlocks.length > 0) {
      return noteBlocks.join('\n\n');
    }
  }

  // Fallback: si tiene [[CTX_NOTES]]
  const ctxNotesIdx = text.indexOf('[[CTX_NOTES]]');
  if (ctxNotesIdx !== -1) {
    return text.slice(ctxNotesIdx).trim();
  }

  return null;
}

/**
 * Selecciona qué mensajes son protegidos (el system prompt inicial y el último mensaje del usuario no deben borrarse).
 */
export function selectProtectedMessageIndexes(messages) {
  const protectedSet = new Set();
  if (messages.length === 0) return protectedSet;

  if (messages[0].role === 'system' || messages[0].role === 'developer') {
    protectedSet.add(0);
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      protectedSet.add(i);
      break;
    }
  }

  return protectedSet;
}

export function renderContextDocument(messages, options = {}) {
  const revision = options.revision ?? 0;
  const persistentNotes = typeof options.persistentNotes === 'string' ? options.persistentNotes.trim() : '';
  const filteredMessages = messages.filter((m) => m?.source?.kind !== 'plugin:dsh-plugin-clm');
  const protectedIndexes = options.protectedIndexes ?? selectProtectedMessageIndexes(filteredMessages);
  const baselineDigest = digestMessages(filteredMessages);
  const stable = options.documentSeed !== undefined;
  const currentDocumentId = documentId(stable ? `seed:${options.documentSeed}` : baselineDigest, revision);

  const blocks = [];

  if (persistentNotes) {
    const notesHeader = `[[CTX_TURN document=${currentDocumentId} index=1 role=notes id=1-system-notes protected=true]]`;
    blocks.push({
      index: 0,
      id: '1-system-notes',
      role: 'notes',
      protected: true,
      header: notesHeader,
      body: persistentNotes,
      source: null,
    });
  }

  const offset = blocks.length;
  filteredMessages.forEach((source, idx) => {
    const blockIdx = idx + offset;
    const id = blockId(source, blockIdx);
    const role = source.role || 'user';
    const isProtected = protectedIndexes.has(idx);
    const rawBody = renderMessage(source);
    const body = stable ? escapeStructuralLines(rawBody) : rawBody;
    const header = `[[CTX_TURN document=${currentDocumentId} index=${blockIdx + 1} role=${role} id=${id} protected=${isProtected}]]`;
    blocks.push({
      index: blockIdx,
      id,
      role,
      protected: isProtected,
      header,
      body,
      source,
    });
  });

  const renderedBlocks = blocks.map((block) => `${block.header}\n${block.body}`);
  const text = [
    `[[LIVE_CONTEXT version=${DOCUMENT_VERSION} revision=${revision} document=${currentDocumentId} baseline=${baselineDigest}]]`,
    '# Context Language Model (CLM) Active Mirror',
    '# Edita los cuerpos de los bloques o elimina bloques CTX_TURN no protegidos para podar memoria.',
    '# Conserva los encabezados de los bloques que quieras mantener.',
    ...renderedBlocks,
  ].join('\n\n');

  return {
    version: DOCUMENT_VERSION,
    revision,
    baselineDigest,
    documentId: currentDocumentId,
    stableDocument: stable,
    persistentNotes,
    text,
    messages: [...filteredMessages],
    blocks,
  };
}

export function parseDocument(text, snapshot) {
  const metadata = META_RE.exec(text);
  const blockRe = /^\[\[CTX_TURN\s+document=([a-f0-9]{16,64})\s+index=(\d+)\s+role=([A-Za-z][A-Za-z0-9_-]*)\s+id=([a-zA-Z0-9-]+)\s+protected=(true|false)\]\]\s*$/gm;

  const matches = [...text.matchAll(blockRe)];
  const blocks = [];
  const seen = new Set();
  const duplicateIds = [];

  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;
    const id = match[4];
    if (seen.has(id)) duplicateIds.push(id);
    seen.add(id);

    blocks.push({
      documentId: match[1],
      index: Number(match[2]) - 1,
      role: match[3],
      id,
      protected: match[5] === 'true',
      body: text.slice(start, end).trim(),
    });
  }

  return {
    version: metadata ? Number(metadata[1]) : undefined,
    revision: metadata ? Number(metadata[2]) : undefined,
    documentId: metadata?.[3] ?? snapshot?.documentId,
    baselineDigest: metadata?.[4],
    blocks,
    duplicateIds,
  };
}

export function createClmMessage(body, role = 'user') {
  return Object.freeze({
    id: randomUUID(),
    role: role === 'assistant' ? 'assistant' : 'user',
    content: Object.freeze([
      Object.freeze({
        type: 'text',
        text: `[CLM Context Note]\n${body}`,
      }),
    ]),
    source: Object.freeze({
      kind: 'plugin:dsh-plugin-clm',
      plugin: 'dsh-plugin-clm',
      form: 'context',
    }),
  });
}

function changedMessage(source, body, role) {
  if (source && (source.role === 'assistant' || source.role === 'user') && source.role === role) {
    return Object.freeze({
      ...source,
      content: Object.freeze([
        Object.freeze({
          type: 'text',
          text: body,
        }),
      ]),
    });
  }
  return createClmMessage(body, role);
}

/**
 * Aplica el documento editado y genera la nueva lista de mensajes proyectados.
 */
export function applyContextDocument(text, snapshot) {
  if (!text || (snapshot && text.trim() === snapshot.text.trim())) {
    return { changed: false, messages: snapshot?.messages ?? [], notes: snapshot?.persistentNotes ?? '' };
  }

  const parsed = parseDocument(text, snapshot);
  const extractedNotes = extractNotesFromDocument(text);

  if (parsed.blocks.length === 0) {
    const plain = text
      .split('\n')
      .filter((l) => !l.startsWith('#') && !l.startsWith('[[LIVE_CONTEXT'))
      .join('\n')
      .trim();

    if (plain.length > 0) {
      return {
        changed: true,
        messages: [createClmMessage(plain, 'user')],
        notes: plain,
        reason: 'plain-summary',
      };
    }
    return { changed: false, messages: snapshot?.messages ?? [], notes: snapshot?.persistentNotes ?? '', reason: 'empty-parse' };
  }

  const originalById = new Map();
  (snapshot?.blocks ?? []).forEach((b) => originalById.set(b.id, b));

  const resultingMessages = [];
  const customNotes = [];

  for (const block of parsed.blocks) {
    const body = snapshot?.stableDocument ? unescapeStructuralLines(block.body) : block.body;
    if (block.role === 'notes' || block.id === '1-system-notes') {
      if (body) customNotes.push(body);
      continue;
    }

    const original = originalById.get(block.id);
    if (!original || !original.source) {
      resultingMessages.push(createClmMessage(body, block.role));
      continue;
    }

    const originalRendered = renderMessage(original.source);
    if (body === originalRendered && block.role === original.role) {
      resultingMessages.push(original.source);
    } else {
      resultingMessages.push(changedMessage(original.source, body, block.role));
    }
  }

  const finalNotes = customNotes.length > 0 ? customNotes.join('\n\n') : (extractedNotes ?? snapshot?.persistentNotes ?? '');

  return {
    changed: true,
    messages: resultingMessages,
    notes: finalNotes,
    reason: 'accepted-edit',
    blocksCount: parsed.blocks.length,
  };
}
