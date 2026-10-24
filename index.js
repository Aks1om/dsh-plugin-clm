import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MirrorStore } from './lib/mirror-store.js';
import {
  renderContextDocument,
  applyContextDocument,
  extractNotesFromDocument,
  createClmMessage,
  parseHeader,
  textFromContent,
} from './lib/context-document.js';
import { applyContextProjection, protectedContextIndexes, visibleContextMessages } from './lib/context-projection.js';
import { estimateTotalTokens, estimateMessageTokens } from './lib/overflow-guard.js';
import { normalizeContextWindowFraction, resolveContextBudget } from './lib/context-budget.js';
import { buildClmPromptSection } from './lib/steering-prompt.js';

export const name = 'dsh-plugin-clm';

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-plugin-clm',
    validate(value) {
      const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      return {
        value: {
          defaultEnabled: typeof raw.defaultEnabled === 'boolean' ? raw.defaultEnabled : true,
          budgetTokens: typeof raw.budgetTokens === 'number' && raw.budgetTokens > 0 ? raw.budgetTokens : 64000,
          reserveTokens: typeof raw.reserveTokens === 'number' && raw.reserveTokens >= 0 ? raw.reserveTokens : 4096,
          contextWindowFraction: normalizeContextWindowFraction(raw.contextWindowFraction),
          retainTailMessages: Number.isSafeInteger(raw.retainTailMessages) && raw.retainTailMessages >= 1 ? raw.retainTailMessages : 4,
          mirrorFilename: typeof raw.mirrorFilename === 'string' && raw.mirrorFilename.trim() ? raw.mirrorFilename.trim() : 'LIVE_CONTEXT.md',
        },
      };
    },
  },
};

function getClmDir(workspaceRoot = process.cwd()) {
  return join(workspaceRoot, '.dsh', 'clm');
}

function readFlagValue(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf8').trim().toLowerCase();
    if (raw === '0' || raw === 'false' || raw === 'off') return false;
    return true;
  } catch {
    return null;
  }
}

function checkSessionFlag(sessionId, workspaceRoot = process.cwd()) {
  try {
    const dir = getClmDir(workspaceRoot);
    if (sessionId && sessionId !== 'default') {
      const perSessionFlag = readFlagValue(join(dir, `.enabled_${sessionId}`));
      if (perSessionFlag !== null) return perSessionFlag;
    }
    const globalFlag = readFlagValue(join(dir, '.enabled'));
    if (globalFlag !== null) return globalFlag;
    return null;
  } catch {
    return null;
  }
}

function setSessionFlag(sessionId, enabled, workspaceRoot = process.cwd()) {
  try {
    const dir = getClmDir(workspaceRoot);
    mkdirSync(dir, { recursive: true });
    const val = enabled ? '1' : '0';
    if (sessionId && sessionId !== 'default') {
      writeFileSync(join(dir, `.enabled_${sessionId}`), val, 'utf8');
    }
    writeFileSync(join(dir, '.enabled'), val, 'utf8');
  } catch {}
}

/**
 * Identifica si una sesión es un subagente, teammate secundario o tarea en background.
 * Los subagentes no deben operar CLM ni pisar los espejos de la conversación principal.
 */
function isSubagentSession(session) {
  if (!session) return true;
  if (session.header?.origin === 'subagent' || session.origin === 'subagent') return true;
  if (session.header?.parentSession || session.parentSession || session.header?.parentSessionId || session.parentSessionId) return true;
  if (typeof session.header?.delegationDepth === 'number' && session.header.delegationDepth > 0) return true;
  if (typeof session.delegationDepth === 'number' && session.delegationDepth > 0) return true;
  return false;
}

export function apply(ctx, config = {}) {
  const defaultEnabled = config.defaultEnabled ?? true;
  const budgetTokens = config.budgetTokens ?? 64000;
  const reserveTokens = config.reserveTokens ?? 4096;
  const contextWindowFraction = normalizeContextWindowFraction(config.contextWindowFraction);
  const retainTailMessages = config.retainTailMessages ?? 4;
  const mirrorFilename = config.mirrorFilename ?? 'LIVE_CONTEXT.md';

  const sessionStates = new Map();
  const contextWindowCache = new Map();

  function updateBudgetForContextWindow(state, contextWindow) {
    state.contextBudget = resolveContextBudget({
      contextWindow,
      fallbackBudgetTokens: budgetTokens,
      reserveTokens,
      contextWindowFraction,
    });
  }

  function updateBudgetFromRequestContext(session, state) {
    const requestContext = session?.requestContext?.();
    const requestHeader = session?.requestHeader?.();
    const headerConfig = requestHeader?.config;
    const headerRouteKnown = typeof headerConfig?.provider === 'string' && typeof headerConfig?.model === 'string';
    const contextRouteMatches = requestContext !== undefined
      && (!headerRouteKnown || (requestContext.provider === headerConfig.provider && requestContext.model === headerConfig.model));
    if (contextRouteMatches && Number.isSafeInteger(requestContext.contextWindow) && requestContext.contextWindow > 0) {
      updateBudgetForContextWindow(state, requestContext.contextWindow);
      state.modelRoute = `${requestContext.provider}/${requestContext.model}`;
      return true;
    }
    return false;
  }

  async function refreshContextBudget(session, state, signal) {
    if (updateBudgetFromRequestContext(session, state)) return state.contextBudget;

    const headerConfig = session?.requestHeader?.()?.config;
    const requestContext = session?.requestContext?.();
    const provider = headerConfig?.provider ?? requestContext?.provider;
    const model = headerConfig?.model ?? requestContext?.model;
    const route = typeof provider === 'string' && typeof model === 'string' ? `${provider}/${model}` : undefined;
    if (route === undefined || typeof ctx.llm?.resolveModelInfo !== 'function') {
      updateBudgetForContextWindow(state, undefined);
      state.modelRoute = route;
      return state.contextBudget;
    }

    if (contextWindowCache.has(route)) {
      updateBudgetForContextWindow(state, contextWindowCache.get(route));
      state.modelRoute = route;
      return state.contextBudget;
    }

    try {
      const info = await ctx.llm.resolveModelInfo(provider, model, signal);
      const contextWindow = info?.context?.contextWindow;
      const valid = Number.isSafeInteger(contextWindow) && contextWindow > 0 ? contextWindow : undefined;
      if (valid !== undefined) contextWindowCache.set(route, valid);
      updateBudgetForContextWindow(state, valid);
    } catch {
      updateBudgetForContextWindow(state, undefined);
    }
    state.modelRoute = route;
    return state.contextBudget;
  }

  function contextBudgetLabel(state) {
    const budget = state.contextBudget;
    if (budget.source === 'model' && budget.contextWindow !== undefined) {
      return `~${budget.budgetLimitTokens.toLocaleString()} / ${budget.contextWindow.toLocaleString()} tokens (${Math.round(budget.contextWindowFraction * 100)}% model window)`;
    }
    return `~${budget.budgetLimitTokens.toLocaleString()} tokens (fallback budget)`;
  }

  function getWorkspaceRoot(session) {
    return session?.header?.cwd || process.cwd();
  }

  function getSessionState(sessionId = 'default', workspaceRoot = process.cwd()) {
    let state = sessionStates.get(sessionId);
    const flagVal = checkSessionFlag(sessionId, workspaceRoot);
    if (!state) {
      const store = MirrorStore.forSession(sessionId, workspaceRoot, mirrorFilename);
      const isEnabled = flagVal !== null ? flagVal : defaultEnabled;
      let initialNotes = '';
      let revision = 0;
      try {
        // Aislamiento estricto: sólo leer notas iniciales si el archivo privado de ESTA sesión existe
        if (existsSync(store.filePath)) {
          const existingDisk = readFileSync(store.filePath, 'utf8');
          initialNotes = extractNotesFromDocument(existingDisk) || '';
          const header = parseHeader(existingDisk);
          const persistedRevision = Number(header?.revision);
          if (header?.session === sessionId && Number.isSafeInteger(persistedRevision) && persistedRevision >= 0) {
            revision = persistedRevision;
          }
        }
      } catch {}
      state = {
        sessionId,
        workspaceRoot,
        enabled: isEnabled,
        store,
        contextBudget: resolveContextBudget({ fallbackBudgetTokens: budgetTokens, reserveTokens, contextWindowFraction }),
        modelRoute: undefined,
        revision,
        snapshot: null,
        pendingDocument: null,
        pendingSync: null,
        persistentNotes: initialNotes,
        notesDelivered: false,
        lastDeliveredNotesHash: '',
        editsCount: 0,
      };
      sessionStates.set(sessionId, state);
      if (isEnabled) {
        setSessionFlag(sessionId, true, workspaceRoot);
      }
    } else {
      if (flagVal !== null && flagVal !== state.enabled) {
        state.enabled = flagVal;
      }
    }
    return state;
  }

  async function syncMirrorForSession(session, extraMessages = []) {
    if (!session || isSubagentSession(session)) return null;
    const workspaceRoot = getWorkspaceRoot(session);
    const state = getSessionState(session.id, workspaceRoot);
    if (!state.enabled) return state;

    try {
      const hadSnapshot = state.snapshot !== null;
      const existingContent = await state.store.read();
      if (existingContent) {
        const diskNotes = extractNotesFromDocument(existingContent);
        if (diskNotes) {
          state.persistentNotes = diskNotes;
        }
      }
      const derived = visibleContextMessages(session);
      const seenIds = new Set(derived.map((m) => m?.id).filter(Boolean));
      const uniqueExtras = extraMessages.filter((m) => !m?.id || !seenIds.has(m.id));
      const allMessages = [...derived, ...uniqueExtras];
      state.snapshot = renderContextDocument(allMessages, {
        revision: state.revision,
        documentSeed: session.id,
        sessionId: session.id,
        persistentNotes: state.persistentNotes,
        protectedIndexes: protectedContextIndexes(allMessages, { retainTailMessages }),
      });
      if (!hadSnapshot && existingContent) {
        const restored = applyContextDocument(existingContent, state.snapshot);
        if (restored.changed && restored.reason === 'accepted-edit') {
          state.pendingDocument = existingContent;
          return state;
        }
      }
      await state.store.write(state.snapshot.text);
    } catch (err) {
      ctx.logger?.warn?.(`[dsh-plugin-clm] Error syncing mirror: ${err instanceof Error ? err.message : String(err)}`);
    }
    return state;
  }

  function setSessionEnabled(sessionId, enabled, session) {
    const workspaceRoot = session ? getWorkspaceRoot(session) : process.cwd();
    const state = getSessionState(sessionId, workspaceRoot);
    state.enabled = enabled;
    setSessionFlag(sessionId, enabled, workspaceRoot);
    if (enabled && session) {
      syncMirrorForSession(session).catch(() => {});
    } else {
      state.store.read().then((content) => {
        if (!content) {
          const initialNotes = `## [CLM Tracker - Estado de la Sesión]\n- Sesión: ${sessionId}\n- Modo CLM: Activo`;
          state.persistentNotes = initialNotes;
          const doc = renderContextDocument([], {
            revision: state.revision,
            documentSeed: sessionId,
            sessionId,
            persistentNotes: initialNotes,
          });
          state.snapshot = doc;
          state.store.write(doc.text).catch(() => {});
        }
      }).catch(() => {});
    }
  }

  /**
   * Poda en superficie (surface replace) los resultados de herramientas antiguos cuando el contexto supera el presupuesto.
   */
  function pruneOverBudgetToolResults(session, budgetLimitTokens = Math.max(8192, budgetTokens - reserveTokens)) {
    if (!session || typeof session.deriveMessages !== 'function' || !session.surface?.nodes) {
      return 0;
    }
    const messages = session.deriveMessages();
    const budgetLimit = budgetLimitTokens;
    let currentTokens = estimateTotalTokens(messages);
    if (currentTokens <= budgetLimit) return 0;

    let prunedCount = 0;
    const nodes = [...session.surface.nodes];
    // No podar los últimos 4 nodos de la superficie para no afectar el paso en curso
    const candidates = nodes.slice(0, Math.max(0, nodes.length - 4));

    for (const seq of candidates) {
      if (currentTokens <= budgetLimit) break;
      const event = session.eventAt?.(seq);
      if (event?.type !== 'tool/result') continue;
      const original = session.deriveEventMessage?.(event);
      if (!original) continue;
      const originalTokens = estimateMessageTokens(original);
      if (originalTokens <= 400) continue;

      const fullText = textFromContent(original.content);
      const head = fullText.slice(0, 600);
      const tail = fullText.slice(-300);
      const prunedText = `${head}\n\n[... CLM Overflow Guard: ${originalTokens} tokens podados automáticamente ...]\n\n${tail}`;

      const replacementMessage = Object.freeze({
        ...original,
        content: Object.freeze([
          Object.freeze({
            type: 'text',
            text: prunedText,
          }),
        ]),
      });

      try {
        session.append(
          'tool/result',
          {
            ...event.data,
            message: replacementMessage,
          },
          {
            surfaceOp: {
              op: 'replace',
              startSeq: seq,
              endSeq: seq,
            },
            sourceEventSeqs: [seq],
          }
        );
        const afterTokens = estimateMessageTokens(replacementMessage);
        currentTokens -= Math.max(0, originalTokens - afterTokens);
        prunedCount++;
      } catch {
        // Si un nodo no puede reemplazarse, continuar con el siguiente
      }
    }

    return prunedCount;
  }

  // 1. Contribución dinámica al Runtime Context del System Prompt.
  //    `systemPrompt` es un servicio de Cordis: debe accederse vía ctx.inject
  //    (o ctx.get como fallback), nunca como propiedad directa del contexto.
  const registerClmSystemPromptContext = (spCtx) => {
    if (!spCtx?.systemPrompt?.context) return;
    spCtx.systemPrompt.context({
      name: 'clm:steering',
      order: 200,
      text: (assemblyCtx) => {
        const session = assemblyCtx?.agent?.session;
        if (isSubagentSession(session)) return '';
        const sessionId = session?.id || 'default';
        const workspaceRoot = getWorkspaceRoot(session);
        const state = getSessionState(sessionId, workspaceRoot);
        if (!state.enabled) return '';
        updateBudgetFromRequestContext(session, state);
        return buildClmPromptSection(state.store.filePath, {
          budgetTokens: state.contextBudget.targetBudgetTokens,
          reserveTokens: state.contextBudget.reserveTokens,
          contextWindowFraction,
          retainTailMessages,
        }).trim();
      },
    });
  };

  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (spCtx) => registerClmSystemPromptContext(spCtx));
  } else {
    registerClmSystemPromptContext({ systemPrompt: ctx.get?.('systemPrompt') });
  }

  // 2. Registro de herramienta nativa `clm` con schema.
  //    `tools` es un servicio de Cordis: mismo patrón que systemPrompt.
  const registerClmTool = (toolsCtx) => {
    if (!toolsCtx?.tools?.register) return;
    toolsCtx.tools.register({
      name: 'clm',
      description: 'Controla Context Language Model (CLM) en la conversación actual. Permite encender (enable), apagar (disable), alternar (toggle), consultar el estado (status) o reiniciar (reset) la memoria viva editable.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['enable', 'disable', 'toggle', 'status', 'reset'],
            description: "Acción a realizar: 'enable' para encender, 'disable' para apagar, 'toggle' para alternar, 'status' para consultar estado actual, 'reset' para reiniciar el espejo.",
          },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            enabled: { type: 'boolean' },
            sessionId: { type: 'string' },
            mirrorPath: { type: 'string' },
            globalMirrorPath: { type: 'string' },
            revision: { type: 'number' },
            message: { type: 'string' },
          },
        },
        render: (output) => {
          if (!output) return null;
          return {
            type: 'text',
            text: output.message || `CLM ${output.status}: ${output.mirrorPath}`,
          };
        },
      },
      handler: async ({ action }, toolCtx) => {
        const session = toolCtx?.agent?.session;
        const sessionId = session?.id || 'default';
        const workspaceRoot = session ? getWorkspaceRoot(session) : process.cwd();
        const state = getSessionState(sessionId, workspaceRoot);
        if (session) await refreshContextBudget(session, state, toolCtx?.signal);

        switch (action) {
          case 'enable': {
            setSessionEnabled(sessionId, true, session);
            if (session) await syncMirrorForSession(session);
            return {
              status: 'enabled',
              enabled: true,
              sessionId,
              mirrorPath: state.store.filePath,
              globalMirrorPath: state.store.globalPath,
              revision: state.revision,
              message: `✅ CLM ACTIVADO para esta conversación.\nArchivo privado: ${state.store.filePath}\nVista global: ${state.store.globalPath || state.store.filePath}`,
            };
          }
          case 'disable': {
            setSessionEnabled(sessionId, false, session);
            return {
              status: 'disabled',
              enabled: false,
              sessionId,
              mirrorPath: state.store.filePath,
              globalMirrorPath: state.store.globalPath,
              message: '⛔ CLM DESACTIVADO para esta conversación. El flujo de contexto vuelve a ser acumulativo normal.',
            };
          }
          case 'toggle': {
            const nextState = !state.enabled;
            setSessionEnabled(sessionId, nextState, session);
            if (nextState && session) await syncMirrorForSession(session);
            return {
              status: nextState ? 'enabled' : 'disabled',
              enabled: nextState,
              sessionId,
              mirrorPath: state.store.filePath,
              globalMirrorPath: state.store.globalPath,
              message: nextState
                ? `✅ CLM ACTIVADO.\nArchivo privado: ${state.store.filePath}`
                : '⛔ CLM DESACTIVADO.',
            };
          }
          case 'reset': {
            state.snapshot = null;
            state.revision = 0;
            state.editsCount = 0;
            state.notesDelivered = false;
            if (session) await syncMirrorForSession(session);
            return {
              status: state.enabled ? 'enabled' : 'disabled',
              enabled: state.enabled,
              sessionId,
              mirrorPath: state.store.filePath,
              globalMirrorPath: state.store.globalPath,
              revision: 0,
              message: `🔄 Espejo de CLM reiniciado y sincronizado con el historial limpio de la sesión (${state.store.filePath}).`,
            };
          }
          case 'status':
          default: {
            const derived = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : [];
            const tokens = estimateTotalTokens(derived);
            return {
              status: state.enabled ? 'enabled' : 'disabled',
              enabled: state.enabled,
              sessionId,
              mirrorPath: state.store.filePath,
              globalMirrorPath: state.store.globalPath,
              revision: state.revision,
              notesLength: state.persistentNotes?.length || 0,
              message: state.enabled
                ? `✅ CLM ACTIVO en sesión ${sessionId} [Rev. ${state.revision} | ${state.editsCount} edits | ~${tokens} used / ${contextBudgetLabel(state)}]\nArchivo privado: ${state.store.filePath}\nVista activa global: ${state.store.globalPath || state.store.filePath}`
                : '⛔ CLM INACTIVO en esta conversación (usa action: "enable" o /clm on para encenderlo).',
            };
          }
        }
      },
    });
  };

  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (toolsCtx) => registerClmTool(toolsCtx));
  } else {
    registerClmTool({ tools: ctx.get?.('tools') });
  }

  // 3. Registro del comando slash /clm (con kind: 'success' compatible con @deepseek-ai/dsh-commands)
  const registerClmCommand = (commandCtx) => {
    commandCtx?.commands?.register({
      name: 'clm',
      description: 'Controla Context Language Model (CLM) en esta conversación',
      input: {
        hint: '[on|off|toggle|status|reset]',
      },
      handler: async ({ agent, rawInput }) => {
        const session = agent?.session;
        const sessionId = session?.id || 'default';
        const workspaceRoot = session ? getWorkspaceRoot(session) : process.cwd();
        const state = getSessionState(sessionId, workspaceRoot);
        if (session) await refreshContextBudget(session, state);
        const arg = (rawInput || '').trim().toLowerCase();

        if (arg === 'on' || arg === 'enable') {
          setSessionEnabled(sessionId, true, session);
          if (session) await syncMirrorForSession(session);
          return {
            kind: 'success',
            text: `✅ CLM ACTIVADO en esta conversación.\nArchivo privado: ${state.store.filePath}\nVista global: ${state.store.globalPath || state.store.filePath}`,
          };
        }
        if (arg === 'off' || arg === 'disable') {
          setSessionEnabled(sessionId, false, session);
          return {
            kind: 'success',
            text: '⛔ CLM DESACTIVADO en esta conversación. El contexto vuelve a ser acumulativo normal.',
          };
        }
        if (arg === 'reset') {
          state.snapshot = null;
          state.revision = 0;
          state.editsCount = 0;
          state.notesDelivered = false;
          if (session) await syncMirrorForSession(session);
          return {
            kind: 'success',
            text: `🔄 Espejo de CLM regenerado para la sesión actual (${state.store.filePath}).`,
          };
        }
        if (arg === 'toggle') {
          const next = !state.enabled;
          setSessionEnabled(sessionId, next, session);
          if (next && session) await syncMirrorForSession(session);
          return {
            kind: 'success',
            text: next
              ? `✅ CLM ACTIVADO en esta conversación.\nArchivo privado: ${state.store.filePath}`
              : '⛔ CLM DESACTIVADO en esta conversación.',
          };
        }

        // Por defecto (/clm o /clm status): si estaba inactivo y llaman /clm sin args, activarlo; si piden status, mostrar métricas
        if (arg === '' && !state.enabled) {
          setSessionEnabled(sessionId, true, session);
          if (session) await syncMirrorForSession(session);
          return {
            kind: 'success',
            text: `✅ CLM ACTIVADO en esta conversación.\nArchivo privado: ${state.store.filePath}`,
          };
        }

        const derived = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : [];
        const tokens = estimateTotalTokens(derived);
        return {
          kind: 'success',
          text: state.enabled
            ? `🧠 [CLM ACTIVO] Sesión: ${sessionId} | Rev. ${state.revision} | Ediciones aplicadas: ${state.editsCount} | ~${tokens} used / ${contextBudgetLabel(state)}.\nArchivo privado: ${state.store.filePath}\nVista global: ${state.store.globalPath || state.store.filePath}`
            : '⛔ [CLM INACTIVO] Usa /clm on o el botón CLM de la barra para activarlo.',
        };
      },
    });
  };

  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (cmdCtx) => registerClmCommand(cmdCtx));
  } else if (ctx.get?.('commands')?.register) {
    registerClmCommand(ctx);
  }

  // 4. Inicialización al crear un agente y sincronización inicial del espejo
  ctx.on('agent/created', async ({ agent, source }) => {
    if (source === undefined || isSubagentSession(agent?.session)) return undefined;
    try {
      const session = agent.session;
      const state = getSessionState(session.id, getWorkspaceRoot(session));
      if (state.enabled) {
        await refreshContextBudget(session, state);
        await syncMirrorForSession(session);
      }
    } catch {}
    return undefined;
  });

  // 5. Apply validated mirror edits before DSH 0.2 admits the next model step.
  ctx.on(
    'agent/pre-step',
    async ({ agent, messages, signal }, next) => {
      const decision = await next();
      const session = agent?.session;
      if (!session || isSubagentSession(session)) return decision;
      if (decision.kind !== 'enter' || signal?.aborted) return decision;

      const sessionId = session.id;
      const workspaceRoot = getWorkspaceRoot(session);
      const state = getSessionState(sessionId, workspaceRoot);
      if (state.pendingSync !== null) await state.pendingSync;
      await refreshContextBudget(session, state, signal);

      // Detectar activación/desactivación por mensaje directo
      const lastUserMsg = (decision.messages || messages || []).filter((m) => m.role === 'user').slice(-1)[0];
      const userText = textFromContent(lastUserMsg?.content);
      if (/^\s*\/clm\s+(on|enable)\b/i.test(userText) || /\b(activar?|encender?)\s+clm\b/i.test(userText)) {
        setSessionEnabled(sessionId, true, session);
      } else if (/^\s*\/clm\s+(off|disable)\b/i.test(userText) || /\b(desactivar?|apagar?)\s+clm\b/i.test(userText)) {
        setSessionEnabled(sessionId, false, session);
      }

      if (!state.enabled) return decision;

      let pendingDocument = null;
      let changedOnDisk = false;
      let diskContent = null;
      const previousNotes = state.persistentNotes;
      try {
        const additions = [];

        // A. Detectar ediciones externas o del agente sobre el archivo privado o LIVE_CONTEXT.md
        pendingDocument = state.pendingDocument;
        state.pendingDocument = null;
        changedOnDisk = pendingDocument !== null || await state.store.hasChanged();
        diskContent = pendingDocument ?? await state.store.read();

        if (diskContent) {
          const extractedNotes = extractNotesFromDocument(diskContent);
          if (extractedNotes) {
            state.persistentNotes = extractedNotes;
          }

          if (changedOnDisk && state.snapshot) {
            const applied = applyContextDocument(diskContent, state.snapshot);
            if (applied.changed && applied.reason === 'accepted-edit') {
              const projection = applyContextProjection(session, state.snapshot, applied, { retainTailMessages });
              state.revision++;
              state.editsCount++;
              state.persistentNotes = applied.notes ?? '';
              additions.push(...projection.extraMessages);
              if (!projection.notesAttached && applied.notes !== state.snapshot.persistentNotes) {
                additions.push(createClmMessage(
                  applied.notes
                    ? `[CLM persistent notes updated, revision ${state.revision}]\n${applied.notes}`
                    : `[CLM persistent notes cleared, revision ${state.revision}]`,
                  'user',
                  'context'
                ));
              }
              if (projection.ranges.length > 0) {
                ctx.logger?.info?.(`[dsh-plugin-clm] Applied ${projection.ranges.length} durable context projection range(s).`);
              }
              state.notesDelivered = true;
            } else if (applied.reason) {
              ctx.logger?.warn?.(`[dsh-plugin-clm] Ignored context mirror edit: ${applied.reason}.`);
            }
          } else if (!state.notesDelivered && state.persistentNotes) {
            // Entregar el bloque de notas vivas al iniciar la conversación
            additions.push(
              createClmMessage(
                `[Memoria Viva CLM cargada desde ${state.store.filePath}]\n${state.persistentNotes}`,
                'user'
              )
            );
            state.notesDelivered = true;
          }
        }

        // B. Ejecutar Overflow Guard sobre nodos tool/result de la superficie si superan el presupuesto
        const prunedNodes = pruneOverBudgetToolResults(session, state.contextBudget.budgetLimitTokens);
        if (prunedNodes > 0) {
          state.revision++;
        }

        // C. Sincronizar el archivo privado y espejo global con los mensajes actuales de la sesión
        const finalMessages = additions.length > 0 ? [...decision.messages, ...additions] : decision.messages;
        await syncMirrorForSession(session, finalMessages);

        if (signal?.aborted) return decision;
        return additions.length > 0
          ? { ...decision, messages: finalMessages }
          : decision;
      } catch (err) {
        if (changedOnDisk && diskContent !== null) state.pendingDocument = diskContent;
        state.persistentNotes = previousNotes;
        ctx.logger?.warn?.(`[dsh-plugin-clm] Error in agent/pre-step: ${err instanceof Error ? err.message : String(err)}`);
        return decision;
      }
    },
    { prepend: true }
  );

  // 6. Refresh only at turn boundaries. A tool may edit the mirror inside a
  // step; rewriting it at step/end would erase that CLM edit before the next
  // agent/pre-step can validate and apply it.
  ctx.on('session/event', async (session, event) => {
    if (!session || isSubagentSession(session)) return;
    if (event?.type === 'turn/end') {
      const state = getSessionState(session.id, getWorkspaceRoot(session));
      if (state.enabled) {
        if (state.pendingDocument !== null) return;
        if (state.pendingSync !== null) return state.pendingSync;
        state.pendingSync = (async () => {
          try {
            const changed = await state.store.hasChanged();
            if (changed) {
              state.pendingDocument = await state.store.read();
              return;
            }
            await syncMirrorForSession(session);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.logger?.warn?.(`[dsh-plugin-clm] Could not check edited mirror before syncing: ${message}`);
          } finally {
            state.pendingSync = null;
          }
        })();
        return state.pendingSync;
      }
    }
  });

  // 7. Limpiar la referencia en memoria y archivo temporal al cerrar sesión
  ctx.on('session/disposed', (session) => {
    const sessionId = session?.id || session;
    sessionStates.delete(sessionId);
  });

  return () => {
    sessionStates.clear();
  };
}
