# ARCHITECTURE_NOTES.md

## TRP1 Challenge — Phase 0: The Archaeological Dig

### Mapping the Nervous System of Roo Code

> **Author:** Forward Deployed Engineer (FDE)
> **Base Extension:** Roo Code (RooCodeInc/Roo-Code)
> **Objective:** Understand Roo Code's internal execution anatomy before injecting the Hook Engine, Intent-Traceability Layer, and `.orchestration/` sidecar system.

---

## 1. Repository Overview & Monorepo Structure

Roo Code is a TypeScript monorepo. The critical packages for this challenge are:

```
RooCodeInc/Roo-Code/
├── src/                              ← Extension Host (Node.js, privileged)
│   ├── extension.ts                  ← Activation entrypoint, registers commands
│   ├── core/
│   │   ├── webview/
│   │   │   └── ClineProvider.ts      ← ★ CORE ORCHESTRATOR: manages Webview ↔ Task lifecycle
│   │   ├── task/
│   │   │   ├── Task.ts               ← ★ CENTRAL EXECUTION ENGINE: ask/say/tool loop
│   │   │   └── build-tools.ts        ← Converts tool definitions → provider format
│   │   ├── assistant-message/
│   │   │   └── presentAssistantMessage.ts  ← ★ TOOL DISPATCHER: routes parsed tool calls
│   │   ├── prompts/
│   │   │   ├── system.ts             ← ★ SYSTEM PROMPT BUILDER: where to inject CLAUDE.md
│   │   │   └── sections/
│   │   │       ├── custom-instructions.ts  ← Loads .roo/rules/, CLAUDE.md, AGENT.md
│   │   │       └── tool-use.ts       ← Tool schema injected into system prompt
│   │   ├── auto-approval/
│   │   │   └── index.ts              ← AutoApprovalHandler: existing Safe/Destructive gate
│   │   └── tools/
│   │       ├── writeToFileTool.ts    ← ★ WRITE HOOK TARGET: intercept here for trace
│   │       ├── executeCommandTool.ts ← ★ COMMAND HOOK TARGET: classify here
│   │       └── readFileTool.ts       ← Safe tool — read-only
│   ├── services/
│   │   └── mcp/
│   │       └── McpHub.ts             ← MCP client: tool discovery + execution
│   └── utils/
│       └── resolveToolProtocol.ts    ← Determines XML vs Native tool calling
├── webview-ui/src/                   ← Webview (sandboxed, UI only)
│   └── components/chat/
│       ├── ChatView.tsx              ← Main chat panel
│       └── ChatTextArea.tsx          ← Input: sends postMessage to Extension Host
└── packages/
    └── types/src/
        └── message.ts                ← Shared message protocol types (IPC contract)
```

---

## 2. The Tool Execution Lifecycle — Request → Approval → Execute

Understanding this pipeline is **the key prerequisite** for injecting hooks. Roo Code follows a strict `request → approval → execute` pattern:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  LLM API Response Stream                                                    │
│  (Anthropic / OpenAI / Gemini)                                              │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ Tool call block detected
                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  presentAssistantMessage.ts                                                 │
│  ► Parses XML tags OR native function call blocks                           │
│  ► Routes to specific tool handler:                                         │
│       write_to_file  → writeToFileTool.ts                                   │
│       execute_command → executeCommandTool.ts                               │
│       read_file      → readFileTool.ts                                      │
│       apply_diff     → (diff strategies)                                    │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ Tool handler calls Task.ask()
                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Task.ts → ask() method  [src/core/task/Task.ts:L899–L1129]                │
│  ► Constructs ClineAsk message {type: "tool", tool: {...}}                  │
│  ► Checks AutoApprovalHandler (alwaysAllowWrite, alwaysAllowExecute, etc.)  │
│  ► If NOT auto-approved: blocks on pWaitFor(() => this.askResponse)         │
│  ► Broadcasts state to Webview via ClineProvider.postStateToWebview()       │
└─────────────┬───────────────────────────────────────────────────────────────┘
              │ User clicks Approve / Reject in UI
              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  handleWebviewAskResponse()  [Task.ts:L1067–L1129]                         │
│  ► Sets this.askResponse → unblocks the Promise                             │
│  ► If approved: tool executes on filesystem / terminal                      │
│  ► If rejected: tool result = error, fed back to LLM context window         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Injection Points Identified

| Hook Phase      | Target File                                   | Target Function / Event                     |
| --------------- | --------------------------------------------- | ------------------------------------------- |
| **PreToolUse**  | `src/core/task/Task.ts`                       | Inside `ask()` BEFORE auto-approval check   |
| **PreToolUse**  | `src/core/tools/writeToFileTool.ts`           | Entry point, before `fs.writeFile()`        |
| **PreToolUse**  | `src/core/tools/executeCommandTool.ts`        | Entry point, before `TerminalRegistry` call |
| **PostToolUse** | `src/core/tools/writeToFileTool.ts`           | After successful write, compute hash + log  |
| **PostToolUse** | `src/core/task/Task.ts` → `recordToolError()` | On failure, trigger circuit breaker         |

---

## 3. The System Prompt Builder — Where to Inject CLAUDE.md & Intent Context

**Critical file:** `src/core/prompts/system.ts`

The system prompt is **generated dynamically per turn**. The `custom-instructions.ts` section already loads:

- `.roo/rules/` — project-level rules files
- `.roo/rules-{mode}/` — mode-specific rules

**Our injection strategy:** The `.orchestration/CLAUDE.md` (Shared Brain) and the intent context block will be loaded via a custom section inserted into the system prompt assembly pipeline here.

```typescript
// src/core/prompts/sections/custom-instructions.ts
// EXISTING: loads .roo/rules/**
// OUR INJECTION: append <intent_context> XML block from active_intents.yaml
// when select_active_intent() has been called this turn
```

The system prompt is the **only reliable enforcement boundary** for the Reasoning Loop requirement. We will append this mandatory protocol block:

```
You are an Intent-Driven Architect operating under the TRP1 Governance Framework.
PROTOCOL RULE: You CANNOT write code or execute commands immediately.
Your FIRST action on any mutating request MUST be to call select_active_intent(intent_id)
to load the architectural constraints for the active work item.
Failure to do so will result in a scope violation error.
```

---

## 4. Tool Protocol Resolution

Roo Code resolves between two protocols at `Task` construction time:

```
resolveToolProtocol() [src/utils/resolveToolProtocol.ts]
    │
    ├── If model supports native function calling (Claude 3.5+, GPT-4, Gemini)
    │       └── NativeToolCallParser (OpenAI-style structured function calls)
    │
    └── If legacy model
            └── AssistantMessageParser (XML tag parsing: <write_to_file>...</write_to_file>)
```

**Impact on Hook Design:** Our custom tool `select_active_intent` must be defined in **both** formats — as a native function call schema in `build-tools.ts` AND as an XML-parseable tag definition — to be model-agnostic.

---

## 5. The Auto-Approval System — Existing Security Gate

**File:** `src/core/auto-approval/index.ts`
**Class:** `AutoApprovalHandler`

This is the existing approval mechanism Roo Code uses. It evaluates every tool call against user settings:

| Setting Flag             | Governs Tool(s)                                 | Our Action                                      |
| ------------------------ | ----------------------------------------------- | ----------------------------------------------- |
| `alwaysAllowReadOnly`    | `read_file`, `list_files`, `search_files`       | Allow passthrough                               |
| `alwaysAllowWrite`       | `write_to_file`, `apply_diff`, `insert_content` | **Intercept here** for scope check + hash       |
| `alwaysAllowExecute`     | `execute_command`                               | **Intercept here** for command classification   |
| `allowedCommands` (list) | Prefix-match allowlist for execute_command      | Augment with deny-list for destructive patterns |

**Critical finding:** The existing `ask()` method already implements the Promise-blocking pattern (`pWaitFor`) we need for HITL. Our Hook Engine will **wrap** this, not replace it.

---

## 6. The ClineProvider — Core Orchestrator

**File:** `src/core/webview/ClineProvider.ts`

This is the glue between the Webview and the Task engine. It:

- Manages the Task lifecycle (creation, stack, subtasks)
- Broadcasts state updates to the Webview UI via `postStateToWebview()`
- Receives Webview messages via `handleWebviewMessage()`
- Manages the MCP Hub (`McpHub.ts`)

**Our injection point for IPC:** The `handleWebviewMessage()` handler is where we will receive the user's `select_active_intent` approval/rejection signals from the Webview. We will add a new message type: `{ type: "intent_selected", intentId: string }`.

---

## 7. The MCP Hub — Dynamic Tool Discovery

**File:** `src/services/mcp/McpHub.ts`

The MCP Hub manages connections to MCP servers. It exposes `listTools()` and `callTool()`.

**Our use:** We will register the `.orchestration/` sidecar operations as a local MCP server (stdio transport) exposing:

| MCP Tool Name           | Purpose                                               |
| ----------------------- | ----------------------------------------------------- |
| `select_active_intent`  | The mandatory "Handshake" tool — loads intent context |
| `list_active_intents`   | Returns all intents from `active_intents.yaml`        |
| `log_trace_record`      | Appends a record to `agent_trace.jsonl`               |
| `check_scope_violation` | Validates file path against intent's `owned_scope`    |
| `get_content_hash`      | Returns SHA-256 hash of a code block                  |
| `record_lesson_learned` | Appends to `CLAUDE.md`                                |

---

## 8. Two-Stage State Machine — The Handshake Protocol

The core innovation is a **mandatory two-state execution model** enforced at the Hook Engine layer:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  STATE 1: REQUEST                                                            │
│  User: "Refactor the auth middleware"                                        │
│  → LLM receives prompt + system prompt with governance protocol              │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │ LLM's first action MUST be:
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  STATE 2: THE HANDSHAKE (Reasoning Intercept)                                │
│  LLM calls: select_active_intent("INT-001")                                  │
│                                                                              │
│  PreToolUse Hook fires:                                                      │
│  1. Validates intent_id exists in active_intents.yaml                        │
│  2. Loads: constraints, owned_scope, acceptance_criteria, recent trace       │
│  3. Constructs: <intent_context>...</intent_context> XML block               │
│  4. Injects context into tool result → resumes LLM execution                 │
│                                                                              │
│  Gatekeeper: If no intent declared → BLOCK + return error                   │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │ LLM now has full context
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  STATE 3: CONTEXTUALIZED ACTION                                              │
│  LLM calls: write_to_file("src/auth/middleware.ts", ...)                     │
│                                                                              │
│  PreToolUse Hook fires:                                                      │
│  1. Verifies active_intent_id is set in session state                        │
│  2. Checks file path against owned_scope → BLOCK if violation                │
│  3. Checks optimistic lock: current_hash == last_known_hash?                 │
│  4. If Destructive: triggers vscode.window.showWarningMessage (HITL)         │
│  5. If approved: execute write                                               │
│                                                                              │
│  PostToolUse Hook fires:                                                     │
│  1. Computes SHA-256 content_hash of written block                           │
│  2. Serializes Agent Trace record → appends to agent_trace.jsonl             │
│  3. Updates intent_map.md with new file→intent mapping                       │
│  4. Runs linter/formatter; feeds errors back to LLM if failed                │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 9. Hook Engine Architecture — Proposed `src/hooks/` Directory

```
src/hooks/
├── HookEngine.ts               ← Central middleware orchestrator
├── PreToolUseHook.ts           ← Intercepts BEFORE any tool executes
├── PostToolUseHook.ts          ← Intercepts AFTER successful tool execution
├── CommandClassifier.ts        ← Classifies execute_command as Safe/Destructive
├── ScopeEnforcer.ts            ← Validates file paths against owned_scope
├── OptimisticLockManager.ts    ← Concurrent write collision detection
├── IntentContextLoader.ts      ← Reads active_intents.yaml, builds context XML
├── TraceSerializer.ts          ← Constructs + appends agent_trace.jsonl records
├── ContentHasher.ts            ← SHA-256 hashing for spatial independence
└── CircuitBreaker.ts           ← Halts runaway loops after N consecutive failures
```

### `HookEngine.ts` — Core Interface Contract

```typescript
export interface HookContext {
	toolName: string // e.g., "write_to_file"
	toolParams: Record<string, any> // Tool input parameters
	activeIntentId: string | null // Currently declared intent
	sessionId: string // Active task session UUID
	workspaceRoot: string // Absolute path to workspace
}

export interface HookResult {
	allow: boolean // true = proceed, false = block
	modifiedParams?: Record<string, any> // Optionally transform params
	injectedContext?: string // Additional context for tool result
	error?: string // Error message if blocked
}

export interface IHookEngine {
	preToolUse(context: HookContext): Promise<HookResult>
	postToolUse(context: HookContext, result: any): Promise<void>
}
```

---

## 10. Sidecar Data Model — `.orchestration/` Directory

All sidecar files are **machine-managed only**. Humans should not hand-edit these during agentic sessions.

### 10.1 `active_intents.yaml` — The Intent Specification

```yaml
active_intents:
    - id: "INT-001"
      name: "JWT Authentication Migration"
      status: "IN_PROGRESS" # PENDING | IN_PROGRESS | DONE | BLOCKED
      created_at: "2026-02-17T00:00:00Z"
      owned_scope:
          - "src/auth/**"
          - "src/middleware/jwt.ts"
      constraints:
          - "Must not use external auth providers"
          - "Must maintain backward compatibility with Basic Auth"
      acceptance_criteria:
          - "All tests in tests/auth/ pass"
          - "No new external npm dependencies introduced"
      last_trace_ref: "uuid-of-last-agent-trace-entry"
```

**Update Pattern:**

- **Pre-Hook** (on `select_active_intent`): Sets `status: IN_PROGRESS`, stamps `last_trace_ref`
- **Post-Hook** (on task completion signal): Sets `status: DONE`

### 10.2 `agent_trace.jsonl` — The Append-Only Ledger

One JSON object per line. Never overwrite — always append.

```jsonc
{
	"id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
	"timestamp": "2026-02-17T14:30:00Z",
	"mutation_class": "AST_REFACTOR", // AST_REFACTOR | INTENT_EVOLUTION | BUG_FIX
	"vcs": {
		"type": "git",
		"revision": "<current git SHA>",
	},
	"session_id": "<roo-task-session-id>",
	"files": [
		{
			"relative_path": "src/auth/middleware.ts",
			"conversations": [
				{
					"url": "<session_log_id>",
					"contributor": {
						"entity_type": "AI",
						"model_identifier": "anthropic/claude-opus-4-5-20251101",
					},
					"ranges": [
						{
							"start_line": 15,
							"end_line": 45,
							"content_hash": "sha256:a8f5f167f44f4964e6c998dee827110c",
						},
					],
					"related": [
						{
							"type": "specification",
							"value": "INT-001", // ← The Golden Thread
						},
					],
				},
			],
		},
	],
}
```

**Spatial Independence:** The `content_hash` is computed over the **exact string content** of the written block at write time. If lines shift due to subsequent edits, the hash remains valid and re-linkable via workspace scan.

### 10.3 `intent_map.md` — The Spatial Map

```markdown
# Intent Spatial Map

_Auto-generated by HookEngine PostToolUse. Do not edit manually._

## INT-001: JWT Authentication Migration

### Files Owned

| File                   | AST Anchor                   | Last Content Hash | Last Modified     |
| ---------------------- | ---------------------------- | ----------------- | ----------------- |
| src/auth/middleware.ts | `authenticateJWT()` function | sha256:a8f5f1...  | 2026-02-17T14:30Z |
| src/middleware/jwt.ts  | Module root                  | sha256:b92c3d...  | 2026-02-17T14:31Z |

### Mutation History

- `2026-02-17T14:30Z` — AST_REFACTOR by claude-opus-4-5 (trace: f47ac10b)
```

### 10.4 `CLAUDE.md` / `AGENT.md` — The Shared Brain

```markdown
# Shared Brain — TRP1 Governed Workspace

_Append-only. Updated by PostToolUse on linter failure or architectural decision._

## Architectural Decisions

- 2026-02-17: Decided to use jose library for JWT over jsonwebtoken — smaller bundle size.

## Lessons Learned

- [LINTER FAIL] ESLint rule no-explicit-any triggered on middleware.ts:22 — use `unknown` instead.
- [SCOPE VIOLATION] Agent attempted to edit src/config/db.ts during INT-001 — reminder: auth scope is bounded to src/auth/\*\* only.

## Project Constitution

- Never introduce external auth providers (rule: INT-001 constraint)
- All new code must have corresponding unit tests in tests/
```

---

## 11. Concurrency Control — Optimistic Locking Protocol

When two agents (Agent A: Architect, Agent B: Builder) operate concurrently, the `OptimisticLockManager` enforces write safety:

```
Agent B initiates task on src/auth/middleware.ts
  → PreToolUse: Record baseline_hash = SHA256(current file content)
  → Store: { file: "src/auth/middleware.ts", baseline_hash: "abc...", intent_id: "INT-001" }

Agent A concurrently modifies src/auth/middleware.ts (architectural comment update)
  → PostToolUse: File on disk now has hash "xyz..."

Agent B attempts write_to_file on src/auth/middleware.ts
  → PreToolUse: Recompute current_hash = SHA256(current file content) = "xyz..."
  → Compare: "xyz..." ≠ "abc..." → COLLISION DETECTED
  → BLOCK write, return error: "Stale File: src/auth/middleware.ts was modified
    by another agent since you last read it. Re-read the file and recalculate your patch."
  → Agent B re-reads file, recomputes diff, retries
```

---

## 12. Command Classification Matrix

The `CommandClassifier.ts` evaluates every `execute_command` payload:

| Classification  | Examples                                                | Hook Action                 |
| --------------- | ------------------------------------------------------- | --------------------------- |
| **SAFE_READ**   | `cat`, `ls`, `grep`, `find`, `git log`, `npm test`      | Auto-allow                  |
| **SAFE_BUILD**  | `npm run build`, `tsc`, `eslint`, `prettier`            | Auto-allow + capture output |
| **DESTRUCTIVE** | `rm -rf`, `git push --force`, `DROP TABLE`, `chmod 777` | HITL modal required         |
| **NETWORK**     | `curl`, `wget`, `ssh`, `scp`                            | HITL modal required         |
| **AMBIGUOUS**   | `npx` (can install + execute arbitrary code)            | HITL modal required         |

---

## 13. Critical Architectural Decisions

### Decision 1: Hook Injection via Middleware Wrapper, Not Monkey-Patching

Rather than modifying `Task.ts` directly (high risk of breaking existing behavior), the Hook Engine will be injected as a **wrapper layer** around the existing tool dispatch path in `presentAssistantMessage.ts`. Every tool call will be routed through `HookEngine.preToolUse()` before the existing tool handler is invoked.

### Decision 2: Sidecar Storage Format — JSONL + YAML over SQLite (Phase 1)

For the interim submission, JSONL + YAML provides human-readable, git-versionable artifacts. SQLite will be evaluated in Phase 4 for query performance when the trace file grows large. This mirrors the Agent Trace specification's intentional storage-agnostic design.

### Decision 3: `select_active_intent` as a Real MCP Tool

Registering this as a proper MCP tool (not a fake hallucinated capability) ensures the LLM receives it in the official tool schema and calls it deterministically. It also means the PreToolUse hook will intercept it through the standard pipeline.

### Decision 4: Content Hashing Strategy — SHA-256 on Full Block

We will hash the **entire written string block** rather than the AST node, as this requires no TypeScript parser dependency at runtime. Post-MVP, we can upgrade to AST-node hashing via `@typescript-eslint/parser` for finer granularity.

---

## 14. Known Risks & Mitigations

| Risk                                                                | Likelihood    | Mitigation                                                                                        |
| ------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------- |
| Agent ignores `select_active_intent` protocol despite system prompt | Medium        | Gatekeeper in PreToolUse blocks any `write_to_file`/`execute_command` if `activeIntentId` is null |
| Line numbers in `agent_trace.jsonl` become stale after refactor     | High          | `content_hash` provides spatial independence; trace is still valid                                |
| Concurrent agents cause `active_intents.yaml` write conflicts       | Medium        | File-level mutex via Node.js `fs.open()` with exclusive flag                                      |
| LLM enters infinite loop after repeated HITL rejections             | Medium        | `CircuitBreaker.ts` halts after 3 consecutive `PostToolUseFailure` events                         |
| Large codebase makes `intent_map.md` unmanageable                   | Low (Phase 1) | SQLite migration in Phase 4; `intent_map.md` scoped to active intents only                        |

---

## 15. Phase 0 Deliverable Summary

This document maps:

1. **The exact files** where Hook Engine injection will occur
2. **The execution flow** from LLM output → tool dispatch → approval → execution
3. **The system prompt assembly point** where governance protocol will be enforced
4. **The data model** for all `.orchestration/` sidecar files
5. **The Two-Stage State Machine** logic (Handshake Protocol)
6. **The concurrency model** for parallel agent orchestration

**Next:** Phase 1 — Implement the Handshake: define `select_active_intent` tool, build `IntentContextLoader.ts`, and inject the governance protocol into the system prompt.

---

_Generated as part of TRP1 Challenge Week 1 — Architecting the AI-Native IDE & Intent-Code Traceability_
_Base: RooCodeInc/Roo-Code | Hook Target: src/core/task/Task.ts, src/core/tools/writeToFileTool.ts_
