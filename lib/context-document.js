import { createHash } from 'node:crypto';

export const DOCUMENT_VERSION = 1;

export const META_RE = /^\[\[LIVE_CONTEXT version=(\d+) revision=(\d+) document=([a-f0-9]{64}) baseline=([a-f0-9]{64})\]\](?:\r?\n|$)/;

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
      if (part.type === 'thinking' && typeof part.thinking === 'string') {
        return `[thinking]\n${part.thinking}`;
      }
      if (part.type === 'toolCall' || part.type === 'tool-call') {
        const name = typeof part.name === 'string' ? part.name : 'tool';
        const args = part.arguments ?? part.input ?? {};
        return `[tool call: ${name}]\n${JSON.stringify(normalizeJson(args))}`;
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
  const parts = [];
  let content = textFromContent(message.content);
  if (content) parts.push(content);

  // Manejar llamadas a herramientas estándar (OpenAI style)
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const toolCall of toolCalls) {
    if (!toolCall || typeof toolCall !== 'object') continue;
    const fn = toolCall.function || {};
    parts.push(`[tool call: ${fn.name || 'tool'}]\n${fn.arguments || ''}`);
  }

  // Manejar mensajes de rol tool
  if (message.role === 'tool' && message.tool_call_id) {
    parts.push(`[tool_call_id: ${message.tool_call_id}]`);
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
 * Selecciona qué mensajes son protegidos (el system prompt inicial y el último mensaje del usuario no deben borrarse).
 */
export function selectProtectedMessageIndexes(messages) {
  const protectedSet = new Set();
  if (messages.length === 0) return protectedSet;

  // Proteger primer mensaje si es system o developer
  if (messages[0].role === 'system' || messages[0].role === 'developer') {
    protectedSet.add(0);
  }

  // Proteger el último mensaje del usuario para no perder la orden actual
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
  const protectedIndexes = options.protectedIndexes ?? selectProtectedMessageIndexes(messages);
  const baselineDigest = digestMessages(messages);
  const stable = options.documentSeed !== undefined;
  const currentDocumentId = documentId(stable ? `seed:${options.documentSeed}` : baselineDigest, revision);

  const blocks = messages.map((source, index) => {
    const id = blockId(source, index);
    const role = source.role || 'user';
    const isProtected = protectedIndexes.has(index);
    const rawBody = renderMessage(source);
    const body = stable ? escapeStructuralLines(rawBody) : rawBody;
    const header = `[[CTX_TURN document=${currentDocumentId} index=${index + 1} role=${role} id=${id} protected=${isProtected}]]`;
    return {
      index,
      id,
      role,
      protected: isProtected,
      header,
      body,
      source,
    };
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
    text,
    messages: [...messages],
    blocks,
  };
}

export function parseDocument(text, snapshot) {
  const metadata = META_RE.exec(text);
  const blockRe = new RegExp(
    `^\\[\\[CTX_TURN document=${escapeRegExp(snapshot.documentId)} index=(\\d+) role=([A-Za-z][A-Za-z0-9_-]*) id=([a-zA-Z0-9-]+) protected=(true|false)\\]\\]\\s*$`,
    'gm'
  );

  const matches = [...text.matchAll(blockRe)];
  const blocks = [];
  const seen = new Set();
  const duplicateIds = [];

  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;
    const id = match[3];
    if (seen.has(id)) duplicateIds.push(id);
    seen.add(id);

    blocks.push({
      index: Number(match[1]) - 1,
      role: match[2],
      id,
      protected: match[4] === 'true',
      body: text.slice(start, end).trim(),
    });
  }

  return {
    version: metadata ? Number(metadata[1]) : undefined,
    revision: metadata ? Number(metadata[2]) : undefined,
    documentId: metadata?.[3],
    baselineDigest: metadata?.[4],
    blocks,
    duplicateIds,
  };
}

function contextNote(body, source, role = 'user') {
  return {
    role: role === 'assistant' ? 'assistant' : 'user',
    content: `[CLM Context Note]\n${body}`,
    timestamp: typeof source?.timestamp === 'number' ? source.timestamp : Date.now(),
  };
}

function changedMessage(source, body, role) {
  if (source.role === 'assistant' && role === 'assistant') {
    return {
      ...source,
      content: body,
    };
  }
  if (source.role === 'user' && role === 'user') {
    return {
      ...source,
      content: body,
    };
  }
  return contextNote(body, source, role);
}

/**
 * Aplica el documento editado y genera la nueva lista de mensajes proyectados.
 */
export function applyContextDocument(text, snapshot, options = {}) {
  // Si el texto está vacío o idéntico
  if (!text || text.trim() === snapshot.text.trim()) {
    return { changed: false, messages: snapshot.messages };
  }

  const parsed = parseDocument(text, snapshot);

  // Si no se encontraron bloques estructurados y el modelo volcó texto plano como resumen
  if (parsed.blocks.length === 0) {
    const plain = text
      .split('\n')
      .filter((l) => !l.startsWith('#') && !l.startsWith('[[LIVE_CONTEXT'))
      .join('\n')
      .trim();

    if (plain.length > 0) {
      // Reemplaza todo con un único bloque de notas de contexto tras el primer mensaje del sistema
      const systemMessage = snapshot.messages.find((m) => m.role === 'system' || m.role === 'developer');
      const preservedUser = snapshot.messages.filter((m) => m.role === 'user').slice(-1)[0];
      const newMessages = [];
      if (systemMessage) newMessages.push(systemMessage);
      newMessages.push(contextNote(plain, null, 'user'));
      if (preservedUser && !plain.includes(renderMessage(preservedUser))) {
        newMessages.push(preservedUser);
      }
      return { changed: true, messages: newMessages, reason: 'plain-summary' };
    }
    return { changed: false, messages: snapshot.messages, reason: 'empty-parse' };
  }

  // Mapa de bloques originales por ID
  const originalById = new Map();
  snapshot.blocks.forEach((b) => originalById.set(b.id, b));

  // Verificar si se eliminaron bloques protegidos
  const parsedIds = new Set(parsed.blocks.map((b) => b.id));
  const missingProtected = snapshot.blocks.filter((b) => b.protected && !parsedIds.has(b.id));

  const resultingMessages = [];

  // Reensamblar bloques
  for (const block of parsed.blocks) {
    const original = originalById.get(block.id);
    const body = snapshot.stableDocument ? unescapeStructuralLines(block.body) : block.body;

    if (!original) {
      // Bloque nuevo insertado por el modelo (ej: id=new-tracker)
      resultingMessages.push(contextNote(body, null, block.role));
      continue;
    }

    const originalRendered = renderMessage(original.source);
    if (body === originalRendered && block.role === original.role) {
      // Intacto
      resultingMessages.push(original.source);
    } else {
      // Modificado
      resultingMessages.push(changedMessage(original.source, body, block.role));
    }
  }

  // Restaurar bloques protegidos que hayan sido omitidos accidentalmente
  if (missingProtected.length > 0) {
    for (const prot of missingProtected) {
      if (!resultingMessages.some((m) => m === prot.source)) {
        resultingMessages.unshift(prot.source);
      }
    }
  }

  return {
    changed: true,
    messages: resultingMessages,
    reason: 'accepted-edit',
    blocksCount: parsed.blocks.length,
  };
}
