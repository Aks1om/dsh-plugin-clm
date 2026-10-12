# 🧠 dsh-plugin-clm (Context Language Models for DeepSeek Harness)

> **Active editable context window mirrored to disk for DeepSeek Harness (DSH).**  
> Inspired by Meta CLM (*Context Language Models*) & `pi-clm`.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![DeepSeek Harness](https://img.shields.io/badge/DSH-Plugin-purple.svg)](https://github.com/anywhere-labs/deepseek-harness)

---

## Overview

**`dsh-plugin-clm`** transforms the conventional monolithic, append-only context window of DeepSeek Harness into an **active, disk-mirrored, and editable context document** (`.dsh/clm/LIVE_CONTEXT.md`).

In standard LLM conversational loops, the chat history grows indefinitely, accumulating bloated tool dumps, stale search outputs, and abandoned debugging attempts. This consumes thousands of tokens and degrades model reasoning over long conversations.

With CLM active, the agent and user can actively **prune, compress, and curate** the live conversational state on disk before each generation step.

---

## ✨ Key Features

- 🔄 **Real-Time Context Synchronization**: Mirrors the ongoing session context into a structured Markdown document (`.dsh/clm/LIVE_CONTEXT.md`).
- ✂️ **Active Context Pruning**: Enables the model to compress extensive terminal dumps and tool results into concise summary notes.
- 🎛️ **Native UI Control**: Seamlessly integrated `[ 🧠 CLM ON 🟢 / CLM OFF ⚪ ]` toggle button in the chat input bar, operating cleanly in the background.
- 🛡️ **Token Overflow Guard**: Automatically enforces context budgets (`budgetTokens: 64000`, `reserveTokens: 4096`) to prevent sudden context overruns.
- ⚡ **Per-Session State Persistence**: Remembers enabled/disabled state across app reloads and per conversation.

---

## 🚀 Installation

### In your DeepSeek Harness desktop profile (`~/.dsh/profiles/desktop/package.json`):

```json
{
  "dependencies": {
    "dsh-plugin-clm": "^1.0.2"
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

Or install via CLI:
```bash
dsh plugin add dsh-plugin-clm
```

---

## 🛠️ Slash Commands

| Command | Description |
|---|---|
| `/clm on` | Enables active editable context mirroring for the current session |
| `/clm off` | Disables CLM mode and falls back to standard append-only context |
| `/clm status` | Displays estimated context tokens, revisions, and mirror file path |
| `/clm reset` | Clears and regenerates a clean mirror state for the session |

---

## 📄 Mirror Document Structure (`LIVE_CONTEXT.md`)

```markdown
# CONTEXT LANGUAGE MODEL (CLM) - ACTIVE MIRROR

[[CTX_NOTES]]
- Objective: Refactor authentication architecture.
- Decisions: Retain JWT tokens in protected in-memory store.

[[CTX_TURN document=sess-1 index=1 role=user]]
Check the server logs for recent authentication errors.

[[CTX_TURN document=sess-1 index=2 role=assistant]]
Examining logs:
[Tool output summarized to the 3 relevant failure entries]
```

---

## 👤 Author & License

Developed by **Maximiliano Roldán** ([@maxeone](https://github.com/maxeone)).  
Distributed under the **MIT License**.
