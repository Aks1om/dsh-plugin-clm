# 🧠 dsh-plugin-clm (Context Language Models for DeepSeek Harness)

> **Active editable context window mirrored to disk for DeepSeek Harness (DSH).**
> Inspired by Meta CLM (*Context Language Models*) & `pi-clm`.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![DeepSeek Harness](https://img.shields.io/badge/DSH-Plugin-purple.svg)](https://github.com/anywhere-labs/deepseek-harness)

---

## 🇪🇸 Descripción en Español

**`dsh-plugin-clm`** transforma la ventana de contexto estática y puramente acumulativa de DeepSeek Harness en un **documento de contexto vivo y editable en disco** (`.dsh/clm/LIVE_CONTEXT.md`).

En las interacciones tradicionales con LLMs, el historial de conversación crece sin control, acumulando volcados gigantescos de terminal, salidas de búsqueda obsoletas y caminos sin salida que desperdician tokens y degradan el razonamiento del modelo. Con CLM, el agente y el usuario pueden podar, resumir y mantener activamente el contexto de la conversación.

### ✨ Características Principales
- 🔄 **Sincronización Bidireccional en Tiempo Real**: Refleja la memoria activa del turno en `.dsh/clm/LIVE_CONTEXT.md`.
- ✂️ **Poda Activa de Contexto**: El modelo puede comprimir salidas extensas de herramientas (`pwsh`, `curl`, `grep`) en notas compactas de 1 o 2 líneas.
- 🎛️ **Toggle Interactivo en la Interfaz Web**: Botón `[ 🧠 CLM ON 🟢 / CLM OFF ⚪ ]` directamente integrado en la barra de herramientas del chat, junto a los permisos y el modo Plan.
- 🛡️ **Overflow Guard**: Previene desbordes accidentales de la ventana de contexto asegurando un presupuesto estricto de tokens (`budgetTokens: 64000`, `reserveTokens: 4096`).
- ⚡ **Persistencia por Conversación**: Recuerda el estado encendido/apagado para cada sesión de chat individualmente.

---

## 🇬🇧 English Description

**`dsh-plugin-clm`** brings Meta's **Context Language Models (CLM)** paradigm to DeepSeek Harness. Instead of an append-only monolithic context, your conversation history is mirrored into a structured, editable Markdown file (`.dsh/clm/LIVE_CONTEXT.md`).

### ✨ Key Highlights
- 🔄 **Live Disk Mirror**: The conversation context is projected into an editable document before each generation turn.
- ✂️ **Active Pruning**: Both user and agent can prune bloated tool outputs, dead ends, or add persistent project notes.
- 🎛️ **Native UI Toggle**: Integrated status chip `[ 🧠 CLM ON / OFF ]` right in the conversation composer bar.
- 🛡️ **Overflow Guard**: Automatic safeguard to keep generation within token budgets.

---

## 🚀 Instalación / Installation

### En tu perfil de DeepSeek Harness (`~/.dsh/profiles/desktop/package.json`):

```json
{
  "dependencies": {
    "dsh-plugin-clm": "^1.0.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-plugin-clm"
      ]
    }
  }
}
```

O instala directamente vía CLI:
```bash
dsh plugin add dsh-plugin-clm
```

---

## 🛠️ Comandos Slash / Slash Commands

| Comando | Acción |
|---|---|
| `/clm on` | Activa la memoria viva editable en la conversación actual |
| `/clm off` | Desactiva CLM y regresa al flujo acumulativo tradicional |
| `/clm status` | Muestra el tamaño estimado en tokens y la revisión del espejo |
| `/clm reset` | Reinicia y regenera el archivo `LIVE_CONTEXT.md` limpio |

---

## 📄 Estructura del Archivo Espejo (`LIVE_CONTEXT.md`)

```markdown
# CONTEXT LANGUAGE MODEL (CLM) - MEMORIA VIVA EDITABLE

[[CTX_NOTES]]
- Objetivo: Refactorizar arquitectura de autenticación.
- Decisiones: Mantener tokens JWT en memoria protegida.

[[CTX_TURN document=sess-1 index=1 role=user]]
Hola, ayúdame a revisar los logs del servidor.

[[CTX_TURN document=sess-1 index=2 role=assistant]]
Analizando registros:
[Salida de logs comprimida a los 3 errores críticos detectados]
```

---

## 👤 Autor & Licencia

Desarrollado por **Maximiliano Roldán** ([@maxeone](https://github.com/maxeone)).  
Distribuido bajo licencia **MIT**.
