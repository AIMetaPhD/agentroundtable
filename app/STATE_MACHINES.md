# Explicit state machines (schema v2)

The app previously inferred state from booleans, free-form strings and in-memory
flags. Schema v2 stores the states below explicitly and rejects illegal
transitions. All transitions live in `state.js`; persistence is in `db.js`;
the single-writer worker is `dispatcher.js`.

## Room

Stored as `room.state`; `paused/ended` are kept as derived compatibility fields.

```text
active --pause--> paused --resume--> active
active --end---> ended
paused --end---> ended
ended  --end---> ended (idempotent)
```

- `pause` aborts the current round/task and stops the worker; queued human
  messages stay queued.
- `resume` drains the queue.
- `end` aborts the current job, cancels every queued job/task, closes SSE and
  is terminal. `resume/pause` after end return 409; no reset API.
- A message sent while paused is accepted, stored and queued; the response
  includes `queued:true`. It is not silently parked.

## Participant

```text
idle --dispatch/task--> processing --success--> idle
processing --failure--> error --next turn--> processing
processing --crash/restart--> unknown
idle/error --disable--> disabled --enable--> idle
```

- `disabled` is a real column now; disabled participants are excluded from
  rounds and tasks, and disabling the current speaker aborts its turn.
- On startup, any `processing` row becomes `unknown` with `last_error`.

## Approval

```text
(none) --create--> active --consume--> consumed
active --revoke--> revoked
active --invalidate--> invalidated
active --expires_at <= now--> expired
```

- Default TTL is 15 minutes (`R2_APPROVAL_TTL_MS`); `expires_at` is stored.
- `steps_allowed` is fixed at 1; an approval is one task, not a fake 1/2 state.
- Terminal approvals cannot be consumed or revoked again.
- The UI exposes a revoke button for active approvals.

## Task

Tasks are first-class rows (`tasks`), not inferred from approvals/messages.

```text
queued --start--> running --complete--> completed
queued/running --cancel--> cancelled
queued/running --crash/restart--> orphaned
running --fail--> failed
```

- `createTaskAndConsume` consumes the approval, creates the task and its queue
  job in one SQLite transaction.
- The task message (`kind=task`) records `complete/failed/cancelled` and the
  scope-guard result; a cancelled task still records writes and guard output.
- `end/pause/disable` abort the provider process; the scope guard runs in a
  `finally` path, so out-of-scope changes are restored even on cancellation.
- Tasks and discussion turns are serialized by one worker, so two tasks cannot
  write the same sandbox file concurrently.

## Job / worker

Durable queue in `jobs`; the worker runs one job at a time.

```text
queued --start--> running --complete--> done
running --pause--> queued (remaining hops are persisted)
running --fail--> failed
queued/running --cancel--> cancelled
running --restart--> interrupted (task jobs) / queued (round jobs)
```

- Every human message creates its own round job; two messages are two rounds,
  not one `rerun` with the last mode.
- Panel/all rounds persist `order` and per-hop `completed` keys
  (`hop:participant`), so A→B→A can run A twice.
- If a hop fails, the chain stops, the job fails, and a system message is
  posted; later agents never answer without their predecessor.
- On restart, a running round resumes from its persisted hop; a running task is
  marked orphaned (a killed write must not be retried silently).

## Message / SSE

- `messages.round_id` + `round_hop` make each chain reply idempotent across
  restarts; a reply is never posted twice.
- `message.status` can be `processing/complete/failed/cancelled`; the UI shows
  non-complete states.
- SSE frames for messages carry `id: <seq>`; `/api/stream` replays messages
  after `Last-Event-ID`. The client also pulls `since=lastSeq` on hello/open,
  de-duplicates by seq and never jumps `lastSeq` to the server value.
- TTS is guarded by a per-text lock; STT requests have a generation token,
  AbortController and temp-file cleanup.

## Invariants now enforced

- `ended` is terminal; no message/task/control can leave it.
- A paused room queues messages and drains them on resume.
- One worker means no concurrent discussion/task writes.
- A consumed approval always has a task row; crash recovery marks it orphaned.
- A task cancellation/end runs the scope guard and records the outcome.
- Panel chain failure cannot be mistaken for a successful dependency chain.
- Reconnect cannot skip messages created while the tab was offline.
- Disabled participants cannot be selected for rounds/tasks.

## Not implemented on purpose

- Multi-room/new-room reset API (schema keeps `room_id`, runtime is one room).
- Per-file OS-level locks; serialization is process-wide, which is sufficient
  for the local single-process deployment.
- Provider-side cancellation acknowledgement beyond killing the child process
  tree; a provider that ignores SIGTERM/KILL is still killed by `taskkill /T /F`.
