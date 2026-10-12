import { textFromContent } from './context-document.js';

export function estimateMessageTokens(message) {
  // Estimación rápida de ~4 caracteres por token
  const text = typeof message.content === 'string'
    ? message.content
    : textFromContent(message.content);
  return Math.ceil(text.length / 4);
}

export function estimateTotalTokens(messages) {
  return messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
}

/**
 * Guarda contra desbordamientos repentinos truncando los resultados de herramientas
 * más antiguos si superan el límite de presupuesto de contexto.
 */
export function applyOverflowGuard(messages, maxTokens = 64000, reserveTokens = 4096) {
  const currentTokens = estimateTotalTokens(messages);
  const budgetLimit = Math.max(8192, maxTokens - reserveTokens);

  if (currentTokens <= budgetLimit) {
    return { modified: false, messages, currentTokens, budgetLimit };
  }

  const result = [...messages];
  let tokens = currentTokens;

  // Trunca desde los primeros tool results hasta los más recientes
  for (let i = 0; i < result.length && tokens > budgetLimit; i++) {
    const msg = result[i];
    const isTool = msg.role === 'tool' || msg.role === 'toolResult' ||
      (Array.isArray(msg.content) && msg.content.some((c) => c.type === 'toolResult'));

    if (isTool) {
      const originalTokens = estimateMessageTokens(msg);
      if (originalTokens > 300) {
        // Reducir este mensaje a una nota concisa
        const note = `[CLM Overflow Guard: Output de herramienta truncado (${originalTokens} tokens originales) para preservar presupuesto de contexto]`;
        result[i] = {
          ...msg,
          content: note,
        };
        const newTokens = estimateMessageTokens(result[i]);
        tokens -= (originalTokens - newTokens);
      }
    }
  }

  return {
    modified: tokens < currentTokens,
    messages: result,
    currentTokens: tokens,
    budgetLimit,
  };
}
