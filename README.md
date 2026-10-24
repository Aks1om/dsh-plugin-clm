# 🧠 dsh-plugin-clm (Context Language Models for DeepSeek Harness)

> **Active editable context window mirrored to disk for DeepSeek Harness (DSH).**  
> Inspired by Meta CLM (*Context Language Models*) & `pi-clm`.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![DeepSeek Harness](https://img.shields.io/badge/DSH-Plugin-purple.svg)](https://github.com/anywhere-labs/deepseek-harness)

---

## Overview

**`dsh-plugin-clm`** mirrors the active DSH context into an editable per-session document (`.dsh/clm/LIVE_CONTEXT.md`). Validated edits are committed as DSH surface replacements, so the model sees a curated projection while the original append-only session events remain intact.

In standard LLM conversational loops, the chat history grows indefinitely, accumulating bloated tool dumps, stale search outputs, and abandoned debugging attempts. This consumes thousands of tokens and degrades model reasoning over long conversations.

With CLM active, the agent and user can actively **prune, compress, and curate** the live conversational state on disk before each generation step. System/developer messages and the recent conversation tail are protected from mirror edits. Stale, duplicate, cross-session, or protected-block edits are rejected.

Supported runtime: `@deepseek-ai/dsh >=0.2.1-rc.2 <0.2.2`.

---

## ✨ Key Features

- 🔄 **Real-Time Context Synchronization**: Mirrors the ongoing session context into a structured Markdown document (`.dsh/clm/LIVE_CONTEXT.md`).
- ✂️ **Active Context Pruning**: Enables the model to compress extensive terminal dumps and tool results into concise summary notes.
- 🎛️ **Session controls**: `/clm on`, `/clm off`, `/clm status`, `/clm reset`, and the `clm` tool.
- 🛡️ **Model-aware budget**: Targets 75% of the active model's advertised context window, reserving up to 4,096 tokens. Configure `contextWindowFraction` from `0.25` to `0.9`; if DSH cannot resolve a model capacity yet, CLM falls back to a 64,000-token budget.
- ⚡ **Per-Session State Persistence**: Remembers enabled/disabled state across app reloads and per conversation.

---

## 🚀 Installation

The project is maintained from the [Aks1om fork](https://github.com/Aks1om/dsh-plugin-clm) and is not currently published to npm. Clone it, then add the local package to the target DSH profile:

```bash
git clone https://github.com/Aks1om/dsh-plugin-clm.git
dsh plugin --profile <profile-name> add ./dsh-plugin-clm
```

The package's `cordis.patch.yml` registers the server plugin and its default configuration. It targets DSH `0.2.1-rc.2` and the `0.2.1` line only.

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
[[LIVE_CONTEXT version=1 revision=0 document=<digest> baseline=<digest> session=<session-id>]]
# Context Language Model (CLM) Active Mirror

[[CTX_TURN document=<digest> index=1 role=notes id=1-system-notes protected=false]]
Objective: Refactor authentication architecture.
Decision: Retain JWT tokens in the protected in-memory store.

[[CTX_TURN document=<digest> index=2 role=user id=2-<message-digest> protected=false]]
Check the server logs for recent authentication errors.

[[CTX_TURN document=<digest> index=3 role=assistant id=3-<message-digest> protected=true]]
Examining logs:
[Tool output summarized to the 3 relevant failure entries]
```

---

## 👤 Author & License

- Original author: **Maximiliano Roldán** ([@maxeone](https://github.com/maxeone)).
- DSH 0.2 maintenance: **Aks1om** ([fork](https://github.com/Aks1om/dsh-plugin-clm)).
- License: **MIT**.
