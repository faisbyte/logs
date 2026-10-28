# Agent session file formats

Recorded from real session files on one developer machine on 2026-10-28, by inspecting structure only (keys, types, enum values, counts).
No transcript content was copied. Formats drift between versions, so re-check before trusting any of this for a new agent version.

| Agent | Versions seen | Files inspected |
|---|---|---|
| Claude Code | 2.1.92, 2.1.111, 2.1.251 to 2.1.310 (11 versions) | 10 sessions + 8 subagent transcripts |
| Codex CLI (VS Code extension) | 0.45.0-alpha.5, 0.81.0-alpha.8 | 5 rollouts |

Both are JSONL: one JSON object per line, append-only. Timestamps are ISO 8601 UTC with milliseconds (`2026-01-21T03:06:23.123Z`).

---

## Claude Code

### Location

```
~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl          main transcript
~/.claude/projects/<encoded-cwd>/<session-uuid>/subagents/agent-<id>.jsonl
~/.claude/projects/<encoded-cwd>/<session-uuid>/subagents/agent-<id>.meta.json
~/.claude/projects/<encoded-cwd>/<session-uuid>/tool-results/*.txt   large tool outputs spilled to disk
~/.claude/projects/<encoded-cwd>/memory/                       not session data
```

- `<encoded-cwd>` is the launch cwd with every non-alphanumeric character replaced by `-` (`/Users/me/GitHub/logs` → `-Users-me-GitHub-logs`). This is **lossy** (dashes, dots and slashes all collapse to `-`), so never decode it. Use the `cwd` field in events.
- The file name equals the `sessionId` field on every event.
- One directory can hold several sessions.

### Common envelope

Most conversational events carry:
`type, uuid, parentUuid, timestamp, sessionId, version, cwd, gitBranch, entrypoint, userType, isSidechain`, and optionally `slug`.

- `version` is the Claude Code version for **that event**. It can change mid-file when a session is resumed after an upgrade (one file had 3 versions).
- `cwd` can change mid-session. In 10 sessions, 10 later cwds were subdirectories of the first and 11 were unrelated paths. The **first** recorded cwd is the launch directory (D7).
- `gitBranch` can change mid-session (one file had 8 branches).
- `entrypoint` values seen: `claude-vscode`, `claude-desktop`.
- The first line is often **not** conversational (`queue-operation` or `bridge-session`) and has no `cwd`.

### Event types

| `type` | Count | Use | Notes |
|---|---|---|---|
| `assistant` | 3064 | **yes** | One content block per line (see below) |
| `user` | 1557 | **yes** | Real prompts, tool results, injected meta |
| `system` | 17 | partly | `subtype`: `compact_boundary`, `api_error`, `local_command`, `stop_hook_summary` |
| `ai-title` | 766 | yes | `{aiTitle, sessionId}`, re-emitted many times; the last one wins |
| `attachment` | 2132 | no | Injected context. `attachment.type`: `total_tokens_reminder`, `deferred_tools_record`, `edited_text_file` (`filename, snippet`), `environment`, `hook_additional_context`, … |
| `last-prompt` | 782 | no | `{lastPrompt, leafUuid}`, duplicates prompt text |
| `queue-operation` | 356 | no | `operation`: `enqueue`, `dequeue`, `remove`; may carry queued prompt `content` |
| `file-history-snapshot` | 108 | maybe later | `snapshot.trackedFileBackups` keyed by file path (mostly repo-relative) |
| `file-history-delta` | 134 | no | `trackingPath, backup, messageId` |
| `cost-state` | 14 | later | `totalCostUSD, totalLinesAdded, totalLinesRemoved, modelUsage, totalDuration` |
| `api-request`, `api-request-blob`, `api-request-shape` | 1987 | **never** | Raw API request records (≥ 2.1.300). Full prompts and system text, so ignore entirely |
| `mode`, `atis-latch`, `bridge-session` | 1187 | no | UI/session bookkeeping |

No `summary`-type events were seen in these versions.

### `assistant` events

```jsonc
{ "type": "assistant", "requestId": "...", "effort": "high",
  "message": { "id": "msg_...", "model": "claude-opus-5-5", "role": "assistant",
               "content": [ /* exactly ONE block */ ], "stop_reason": "tool_use" | "end_turn" | null,
               "usage": { "input_tokens", "output_tokens", "cache_read_input_tokens", ... } } }
```

- **Streaming split:** every line has exactly one content block. One API response is spread across 1 to 9 lines that share `message.id`. Group by `message.id` to count responses.
- Block types: `text` (`text`), `thinking` (`thinking`, `signature`), `tool_use` (`id`, `name`, `input`, `caller`).
- `thinking` is usually empty: 277 of 1230 blocks had text. The rest are signature-only.
- Models seen: `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-sonnet-4-6`.

Tool `input` keys seen:

| Tool | Input keys | Files touched? |
|---|---|---|
| `Write` | `file_path, content` | yes (`file_path`) |
| `Edit` | `file_path, old_string, new_string, replace_all` | yes (`file_path`) |
| `Read` | `file_path, offset?, limit?` | read only |
| `Bash` | `command, description?, timeout?` | not structurally |
| `Glob` | `pattern, path` | no |
| `WebFetch` | `url, prompt` | no |
| `Agent` | `description, prompt, subagent_type, isolation?, run_in_background?` | via subagent file |
| `Skill`, `AskUserQuestion`, `ToolSearch`, `EnterPlanMode`, `ExitPlanMode` (`plan, planFilePath`), `Monitor` | various | no |

`MultiEdit` and `NotebookEdit` (`notebook_path`) weren't seen here but exist in other versions. Treat them as edits.

### `user` events: three kinds

1. **Real human prompt.** `message.content` is a string, or an array of `text` blocks. Newer versions add `origin.kind: "human"`, `promptSource`, `turnOrigin: "human"`. Array prompts may also carry IDE context blocks (`<ide_opened_file>…`, `<ide_selection>…`) and `image`/`document` blocks.
2. **Tool result.** `message.content` is an array of `tool_result` blocks (`tool_use_id`, `content`: string or array of `text`/`image`/`tool_reference`, `is_error?`). The event also carries `toolUseResult`, a structured copy that's often **much** larger: `stdout/stderr` for Bash, `filePath/structuredPatch/originalFile` (the whole original file) for Edit and Write, `file.content` for Read. It also has `sourceToolAssistantUUID`.
3. **Injected or meta.** Not typed by the human:
   - `isMeta: true` (local-command caveats, skill bodies)
   - string content starting with `<command-name>`, `<command-message>`, `<command-args>`, `<local-command-stdout>`, `<local-command-caveat>`, `<task-notification>` (background task notices; `origin.kind: "task-notification"`)
   - `isCompactSummary: true` (summary injected after context compaction)
   - text `[Request interrupted by user]` or `[Request interrupted by user for tool use]`, an interruption marker that's useful for spotting abandoned work

Tool result sizes: median 381 chars, p90 about 5 KB, max **525 KB**. Truncation is essential.

### Subagents

- `subagents/agent-<id>.jsonl` has the same event schema with `isSidechain: true` and an `agentId`. Its `sessionId` is the **parent's** session ID.
- `agent-<id>.meta.json` keys: `agentType, description, toolUseId, spawnDepth, finished, isBuiltIn, launchedWithDefaults, requestNonInteractive, requestShape`, plus `spawnedWithWorktree, worktreePath, worktreeBranch` for worktree subagents.
- Subagent cwd is the parent's cwd, or a subdirectory of it (worktrees under `.claude/worktrees/`).

### Commits

52 successful `git commit` tool calls, **all** with `-q`, so no `[branch sha] message` line appears in the output. The SHA appears only if the agent also ran `git log --oneline` afterwards. That's why commit SHAs come from git, not the transcript (D6).

---

## Codex CLI

### Location

```
~/.codex/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDTHH-MM-SS>-<session-uuid>.jsonl
```

- The date folders and the file-name timestamp are **local time**. Event timestamps are UTC.
- Other files in `~/.codex/` (`auth.json`, `*.sqlite`, `config.toml`, …) are not session data. **Never read `auth.json`.**

### Envelope

Every line is `{ "timestamp", "type", "payload" }`, and most payloads have their own `payload.type`.

| `type` / `payload.type` | Use | Shape |
|---|---|---|
| `session_meta` | **yes** | `id, timestamp, cwd, originator, cli_version, source, instructions, git{commit_hash, branch, repository_url}`, `model_provider` (0.81) |
| `turn_context` | yes | per turn: `cwd, model, approval_policy, sandbox_policy, effort?, summary`, `user_instructions` and `truncation_policy` (0.81) |
| `response_item/message` | **yes** (assistant) | `role`: `user`, `developer`, `assistant`; `content[]` of `input_text`/`output_text` `{text}` |
| `response_item/reasoning` | yes | `summary[]` of `summary_text {text}`, `content: null`, `encrypted_content` |
| `response_item/function_call` | **yes** | `name, arguments` (**JSON-encoded string**), `call_id` |
| `response_item/function_call_output` | yes (truncated) | `call_id, output`: for `shell`, a JSON string `{output, metadata{exit_code, duration_seconds}}`; otherwise plain text |
| `event_msg/user_message` | **yes** (prompts) | `message`, `kind?` (`plain`, `environment_context`, 0.45), `images` (0.81) |
| `event_msg/agent_message` | no | duplicate of assistant `response_item/message` |
| `event_msg/agent_reasoning` | no | duplicate of reasoning summary |
| `event_msg/token_count` | later | `info{total_token_usage, last_token_usage, model_context_window}` (`info` can be null), `rate_limits` |
| `event_msg/turn_aborted` | yes | `reason: "interrupted"`, an abandonment signal |

- `originator` seen: `codex_vscode`. `source`: `vscode`, `exec`.
- Models seen (`turn_context.model`): `gpt-5-codex`, `gpt-5.2-codex`, `gpt-5.1-codex-mini`.
- `session_meta.cwd` matched every `turn_context.cwd` in the data seen.

### User prompts appear twice

The human prompt is in both `event_msg/user_message` and `response_item/message` (role `user`). `response_item` user messages **also** include injected context (`# AGENTS.md instructions…`, `<environment_context>…`). So prompts come from `event_msg/user_message`, skipping `kind: environment_context` and messages starting with `<environment_context>`.

The VS Code extension wraps typed prompts in a template:

```
# Context from my IDE setup:
## Open tabs:
- …
## My request for Codex:
<the actual prompt>
```

Keep only the text after `## My request for Codex:` when that header is present.

### Tools

- 0.45: `shell` with arguments `{command: ["bash", "-lc", "<script>"], workdir}`, and `update_plan` with arguments `{plan: [{step, status}]}`.
- File edits normally arrive through `apply_patch`, with patch headers `*** Update File: <path>`, `*** Add File: <path>`, `*** Delete File: <path>`. There are two carriers:
  - a heredoc inside a `shell` script: `apply_patch <<'PATCH' … PATCH`
  - in newer versions, its own item: `response_item/custom_tool_call` `{name: "apply_patch", input: "<patch text>", call_id, status}`, answered by `custom_tool_call_output` `{call_id, output}`

  **Neither was seen on this machine:** the one session with tool calls was read-only. Fixtures model both from the upstream format, and they're the only fixture shapes not observed locally.
- Tool output size: median about 1.4 KB, max about 9 KB.

### Short and empty sessions

The four 0.81 rollouts each last under 1 second and contain one user prompt and no assistant output. Each `vscode` rollout has an `exec` twin (`gpt-5.1-codex-mini`) created in the same second. They're listed as normal sessions with 0 assistant messages; whether to hide them is a later call.
