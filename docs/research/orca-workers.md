# Orca workers and the Pi subagent backend

## conclusion

The current extension does not use Orca-native workers. It uses Orca as a terminal transport and starts child Pi processes in split panes.

Using Orca workers would be sensible only as a separate backend or mode for users who want Orca-owned agent lifecycle, worktree placement, remote execution, and supervised task coordination. It is not a drop-in replacement for the current Pi subagent model.

## what Orca provides

### native agent launches

`orca agent launch` starts a known Orca/TUI agent in an existing worktree. It can launch a chat or terminal surface, accept a prompt, model, and effort, and can reveal the new session with `--focus`. `orca worktree create --agent` combines new checkout creation with an agent launch.

Sources:

- `/Applications/Orca.app/Contents/Resources/bin/orca agent launch --help`
- `/Applications/Orca.app/Contents/Resources/bin/orca worktree create --help`

### supervised workers

`orca orchestration worker-start` is the stronger worker abstraction. It starts a worker for a durable Run/Task/Dispatch, using an Orca agent or an existing terminal, with optional worktree placement, dependencies, model, effort, timeout, and remote environment. The orchestration layer then provides worker messages, lifecycle state, worker output, stop/abandon/release operations, and settlement accounting.

The bundled `orchestration` skill describes the lifecycle as:

- Run: durable coordination namespace
- Task: the work specification
- Dispatch: the authoritative attempt
- worker completion: an explicit `worker_done` outcome
- settled worker terminal: reused, retained, or released

Sources:

- `/Applications/Orca.app/Contents/Resources/bin/orca orchestration worker-start --help`
- `/Applications/Orca.app/Contents/Resources/bin/orca skills get orchestration`

## what this extension currently does

`pi-extension/subagents/orca.ts` uses only Orca terminal commands: split, set pane title, send, read, and close. `pi-extension/subagents/index.ts` constructs a literal `pi` child command and sends it to the new pane.

The existing Pi orchestration owns the rest of the contract:

- `.pi/agents` profiles and agent names such as `scout` and `worker`
- Pi model/thinking/tool allowlists and sandbox snapshots
- Pi session files and resume-by-name
- completion sentinels and sidecar result files
- steering the result back into the parent Pi session
- nested Pi spawning permissions

Sources:

- `pi-extension/subagents/orca.ts`
- `pi-extension/subagents/index.ts`
- `README.md`

## why the terminal backend was chosen

The repository already had a clean surface adapter boundary around the existing Pi orchestration. Replacing the tmux surface implementation with Orca terminal operations preserved the Pi-specific behavior while changing only pane creation, input, output, and cleanup.

An Orca-worker backend would require a different integration contract:

1. map Pi agent profiles and tool/model/sandbox settings to Orca agent IDs and launch options;
2. map Pi session files and resume semantics to Orca worker sessions;
3. bridge Orca `worker_done`/transcript results back into Pi `steer` messages;
4. preserve nested spawning and per-session ownership;
5. define cleanup and recovery when Orca reports a worker as live, exited, or unverifiable;
6. decide whether workers run in the current worktree, a child worktree, or a remote environment.

That would add a hard dependency on Orca's orchestration protocol and its provider-specific agent catalog. It would also be overkill for the current fire-and-forget Pi subagent feature.

## recommendation

Keep the terminal backend as the default for Pi-native subagents. Consider an optional Orca-native backend only if the product goal changes to native Orca agents, cross-worktree/remote execution, or durable Orca supervision. For a simple native-agent launch, `orca agent launch` is the closer API; `orchestration worker-start` is appropriate when durable task/dispatch supervision is actually wanted.
