import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MirrorStore } from './lib/mirror-store.js';
import {
  renderContextDocument,
  applyContextDocument,
  canonicalMessage,
} from './lib/context-document.js';
import { applyOverflowGuard, estimateTotalTokens } from './lib/overflow-guard.js';
import { buildClmPromptSection } from './lib/steering-prompt.js';

export const name = 'dsh-plugin-clm';
export const inject = ['tools'];

export const Config = {
  type: 'object',
  properties: {
    defaultEnabled: {
      type: 'boolean',
      description: 'Estado inicial de CLM para nuevas conversaciones (true: activo por defecto, false: inactivo)',
      default: false,
    },
    budgetTokens: {
      type: 'number',
      description: 'Presupuesto máximo de tokens objetivo para la ventana de contexto',
      default: 64000,
    },
    reserveTokens: {
      type: 'number',
      description: 'Margen de tokens reservados para generación de respuesta',
      default: 4096,
    },
    mirrorFilename: {
      type: 'string',
      description: 'Nombre del archivo espejo de contexto en disco',
      default: 'LIVE_CONTEXT.md',
    },
  },
};

function getClmDir(workspaceRoot = process.cwd()) {
  return join(workspaceRoot, '.dsh', 'clm');
}

function checkSessionFlag(sessionId, workspaceRoot = process.cwd()) {
  try {
    const dir = getClmDir(workspaceRoot);
    const flagPath = join(dir, `.enabled_${sessionId}`);
    const globalFlag = join(dir, '.enabled');
    if (existsSync(flagPath)) return true;
    if (existsSync(globalFlag)) return true;
    return null;
  } catch {
    return null;
  }
}

function setSessionFlag(sessionId, enabled, workspaceRoot = process.cwd()) {
  try {
    const dir = getClmDir(workspaceRoot);
    mkdirSync(dir, { recursive: true });
    const flagPath = join(dir, `.enabled_${sessionId}`);
    if (enabled) {
      writeFileSync(flagPath, '1', 'utf8');
    } else {
      if (existsSync(flagPath)) unlinkSync(flagPath);
    }
  } catch {}
}

export function apply(ctx, config = {}) {
  const defaultEnabled = config.defaultEnabled ?? false;
  const budgetTokens = config.budgetTokens ?? 64000;
  const reserveTokens = config.reserveTokens ?? 4096;
  const mirrorFilename = config.mirrorFilename ?? 'LIVE_CONTEXT.md';

  /**
   * Mapa de estado por sesión:
   * sessionId -> {
   *   enabled: boolean,
   *   store: MirrorStore,
   *   revision: number,
   *   snapshot: ContextDocumentSnapshot | null,
   *   projectedMessages: Array | null,
   *   editsCount: number
   * }
   */
  const sessionStates = new Map();

  function getSessionState(sessionId = 'default') {
    let state = sessionStates.get(sessionId);
    const flagVal = checkSessionFlag(sessionId);
    if (!state) {
      const store = MirrorStore.forSession(sessionId, process.cwd(), mirrorFilename);
      const isEnabled = flagVal !== null ? flagVal : defaultEnabled;
      state = {
        sessionId,
        enabled: isEnabled,
        store,
        revision: 0,
        snapshot: null,
        projectedMessages: null,
        editsCount: 0,
      };
      sessionStates.set(sessionId, state);
    } else {
      if (flagVal !== null && flagVal !== state.enabled) {
        state.enabled = flagVal;
      }
    }
    return state;
  }

  function setSessionEnabled(sessionId, enabled) {
    const state = getSessionState(sessionId);
    state.enabled = Boolean(enabled);
    setSessionFlag(sessionId, state.enabled);
    if (!state.enabled) {
      // Al desactivar, limpiamos la proyección para volver al flujo append-only nativo
      state.projectedMessages = null;
      state.snapshot = null;
    } else {
      // Al activar, asegurar que el archivo LIVE_CONTEXT.md existe para que el usuario pueda usarlo
      state.store.read().then((content) => {
        if (!content) {
          const initialDoc = `# CONTEXT LANGUAGE MODEL (CLM) - MEMORIA VIVA EDITABLE\n\nEste archivo refleja el contexto activo de la conversación actual (${sessionId}).\nCualquier cambio o poda que hagas aquí será respetado por el agente.\n\n[[CTX_NOTES]]\n- Sesión: ${sessionId}\n- Modo CLM: Activo\n`;
          state.store.write(initialDoc).catch(() => {});
        }
      }).catch(() => {});
    }
    return state;
  }

  /**
   * Inyecta la guía de CLM en el mensaje de sistema de la lista de mensajes.
   */
  function injectSteeringIntoMessages(messages, mirrorPath) {
    const promptSection = buildClmPromptSection(mirrorPath, { budgetTokens, reserveTokens });
    const result = [...messages];

    const systemIndex = result.findIndex((m) => m.role === 'system' || m.role === 'developer');
    if (systemIndex !== -1) {
      const originalSystem = result[systemIndex];
      const origContent = typeof originalSystem.content === 'string'
        ? originalSystem.content
        : JSON.stringify(originalSystem.content);

      if (!origContent.includes('# CONTEXT LANGUAGE MODEL (CLM)')) {
        result[systemIndex] = {
          ...originalSystem,
          content: `${origContent}\n\n${promptSection}`,
        };
      }
    } else {
      result.unshift({
        role: 'system',
        content: promptSection.trim(),
      });
    }

    return result;
  }

  // 1. Registro de herramienta nativa para alternar CLM
  if (ctx.tools?.register) {
    ctx.tools.register({
      name: 'clm',
      description:
        'Controla Context Language Model (CLM) en la conversación actual. Permite encender (enable), apagar (disable), alternar (toggle) o consultar el estado de la memoria editable.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['enable', 'disable', 'toggle', 'status', 'reset'],
            description: "Acción a realizar: 'enable' para encender, 'disable' para apagar, 'toggle' para alternar, 'status' para estado actual, 'reset' para reiniciar el espejo.",
          },
        },
        required: ['action'],
      },
      execute: async ({ action }, execCtx) => {
        const sessionId = execCtx?.sessionId || execCtx?.session?.id || 'default';
        const state = getSessionState(sessionId);

        switch (action) {
          case 'enable': {
            setSessionEnabled(sessionId, true);
            return {
              status: 'enabled',
              message: `✅ CLM ACTIVADO para esta conversación. El archivo espejo está activo en: ${state.store.filePath}`,
              mirrorPath: state.store.filePath,
              revision: state.revision,
            };
          }
          case 'disable': {
            setSessionEnabled(sessionId, false);
            return {
              status: 'disabled',
              message: '⛔ CLM DESACTIVADO para esta conversación. El flujo de contexto vuelve a ser acumulativo normal.',
            };
          }
          case 'toggle': {
            const nextState = !state.enabled;
            setSessionEnabled(sessionId, nextState);
            return {
              status: nextState ? 'enabled' : 'disabled',
              message: nextState
                ? `✅ CLM ACTIVADO para esta conversación (${state.store.filePath})`
                : '⛔ CLM DESACTIVADO para esta conversación.',
            };
          }
          case 'reset': {
            state.projectedMessages = null;
            state.snapshot = null;
            state.revision = 0;
            state.editsCount = 0;
            await state.store.cleanup();
            return {
              status: state.enabled ? 'enabled' : 'disabled',
              message: '🔄 Espejo de contexto reiniciado para la sesión actual.',
            };
          }
          case 'status':
          default: {
            const tokens = state.snapshot ? estimateTotalTokens(state.snapshot.messages) : 0;
            return {
              enabled: state.enabled,
              sessionId,
              mirrorPath: state.store.filePath,
              revision: state.revision,
              acceptedEdits: state.editsCount,
              estimatedTokens: tokens,
              budgetTokens,
              message: state.enabled
                ? `CLM ACTIVO [Rev: ${state.revision}, Ediciones: ${state.editsCount}, ~${tokens} tokens]`
                : 'CLM INACTIVO en esta conversación (usa action: "enable" para encenderlo).',
            };
          }
        }
      },
    });
  }

  // 2. Registro del comando slash /clm
  const registerClmCommand = (commandCtx) => {
    commandCtx?.commands?.register({
      name: 'clm',
      description: 'Controla Context Language Model (CLM) en esta conversación',
      input: {
        hint: '[on|off|toggle|status|reset]',
      },
      handler: ({ agent, rawInput }) => {
        const arg = rawInput ? rawInput.trim().toLowerCase() : '';
        const sessionId = agent?.session?.id || 'default';
        const state = getSessionState(sessionId);

        if (arg === 'on' || arg === 'enable') {
          setSessionEnabled(sessionId, true);
          return {
            kind: 'success',
            text: `✅ CLM ACTIVADO en esta conversación.\nArchivo espejo: ${state.store.filePath}`,
          };
        }
        if (arg === 'off' || arg === 'disable') {
          setSessionEnabled(sessionId, false);
          return {
            kind: 'success',
            text: '⛔ CLM DESACTIVADO en esta conversación. El contexto vuelve a ser acumulativo normal.',
          };
        }
        if (arg === 'reset') {
          state.projectedMessages = null;
          state.snapshot = null;
          state.revision = 0;
          state.editsCount = 0;
          return {
            kind: 'success',
            text: '🔄 Espejo de CLM reiniciado para la sesión actual.',
          };
        }
        if (arg === 'toggle' || arg === '') {
          const next = !state.enabled;
          setSessionEnabled(sessionId, next);
          return {
            kind: 'success',
            text: next
              ? `✅ CLM ACTIVADO en esta conversación.\nArchivo espejo: ${state.store.filePath}`
              : '⛔ CLM DESACTIVADO en esta conversación.',
          };
        }

        const tokens = state.snapshot ? estimateTotalTokens(state.snapshot.messages) : 0;
        return {
          kind: 'info',
          text: state.enabled
            ? `[CLM ACTIVO] Revisión: ${state.revision}, Ediciones: ${state.editsCount}, ~${tokens} tokens.\nEspejo: ${state.store.filePath}`
            : '[CLM INACTIVO] Usa /clm on o el botón de la barra para activarlo.',
        };
      },
    });
  };

  if (ctx.commands?.register) {
    registerClmCommand(ctx);
  } else if (ctx.inject) {
    ctx.inject(['commands'], (cmdCtx) => registerClmCommand(cmdCtx));
  }

  // 3. Interceptor waterfall de llm/stream
  ctx.on(
    'llm/stream',
    async (options, next) => {
      const sessionId = options.sessionId || 'default';
      const state = getSessionState(sessionId);

      // A0. Detección automática en el mensaje del usuario (por si se envía /clm on o viene del toggle)
      const lastUserMsg = (options.messages || []).filter(m => m.role === 'user').slice(-1)[0];
      let userText = '';
      if (typeof lastUserMsg?.content === 'string') {
        userText = lastUserMsg.content;
      } else if (Array.isArray(lastUserMsg?.content)) {
        const textBlock = lastUserMsg.content.find(b => b.type === 'text');
        userText = textBlock?.text || '';
      }

      if (/^\s*\/clm\s+(on|enable)/i.test(userText) || /\b(activar?|encender?)\s+clm\b/i.test(userText)) {
        setSessionEnabled(sessionId, true);
        if (typeof lastUserMsg.content === 'string') {
          lastUserMsg.content = lastUserMsg.content.replace(/^\s*\/clm\s+(on|enable)\s*\n?/i, '').trim();
          if (!lastUserMsg.content) {
            lastUserMsg.content = '¿Está activo el Context Language Model (CLM) y cómo puedo usar mi archivo LIVE_CONTEXT.md?';
          }
        }
      } else if (/^\s*\/clm\s+(off|disable)/i.test(userText) || /\b(desactivar?|apagar?)\s+clm\b/i.test(userText)) {
        setSessionEnabled(sessionId, false);
      }

      // Si está desactivado en esta conversación, continuar sin modificar nada
      if (!state.enabled) {
        return next();
      }

      try {
        // A. Verificar si el modelo editó el archivo de espejo en el paso anterior
        if (state.snapshot && (await state.store.hasChanged())) {
          const editedText = await state.store.read();
          if (editedText) {
            const applyResult = applyContextDocument(editedText, state.snapshot);
            if (applyResult.changed) {
              state.projectedMessages = applyResult.messages;
              state.revision++;
              state.editsCount++;
            }
          }
        }

        // B. Determinar la base de mensajes para este turno
        let effectiveMessages = state.projectedMessages || options.messages || [];

        // C. Aplicar Overflow Guard para prevenir desbordes de contexto
        const guardResult = applyOverflowGuard(effectiveMessages, budgetTokens, reserveTokens);
        if (guardResult.modified) {
          effectiveMessages = guardResult.messages;
          state.projectedMessages = effectiveMessages;
        }

        // D. Renderizar y sincronizar el archivo de espejo en disco
        state.snapshot = renderContextDocument(effectiveMessages, {
          revision: state.revision,
          documentSeed: sessionId,
        });
        await state.store.write(state.snapshot.text);

        // E. Inyectar el steering de CLM en el prompt para que el LLM conozca la ruta del espejo
        const messagesWithSteering = injectSteeringIntoMessages(effectiveMessages, state.store.filePath);

        // F. Llamar al siguiente listener con los mensajes proyectados
        return next({
          ...options,
          messages: messagesWithSteering,
        });
      } catch (err) {
        // En caso de cualquier error en el pipeline de CLM, degradar con gracia a la petición original
        console.error('[dsh-plugin-clm] Error processing CLM context:', err);
        return next();
      }
    },
    {
      global: true,
      prepend: true,
    }
  );

  // 3. Limpieza al destruir la sesión
  ctx.on('session/disposed', (session) => {
    const sessionId = session?.id || session;
    const state = sessionStates.get(sessionId);
    if (state) {
      state.store.cleanup().catch(() => {});
      sessionStates.delete(sessionId);
    }
  });

  return () => {
    sessionStates.clear();
  };
}
