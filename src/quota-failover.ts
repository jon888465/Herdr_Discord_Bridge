import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRecord } from "./types.js";
import type { HandoffRecord } from "./handoff-store.js";
import { publicText, sessionIdentity } from "./handoff-evidence.js";
import { sameTaskSession } from "./team-task-engine.js";
import type { SessionHandoffRuntime } from "./session-handoff.js";

export type QuotaState = "available" | "limited" | "exhausted" | "unknown";
export interface QuotaObservation {
  agent: AgentRecord;
  state: QuotaState;
  group: string;
  observedAt: string;
  expiresAt: string;
  reportedBy: string;
}
export interface FailoverPolicy {
  id: string;
  source: AgentRecord;
  candidates: AgentRecord[];
  origin: HandoffRecord["origin"];
  goal: string;
  state:
    | "armed"
    | "checkpointing"
    | "ready"
    | "running"
    | "completed"
    | "blocked"
    | "cancelled";
  createdAt: string;
  updatedAt: string;
  checkpointId?: string;
  destination?: AgentRecord;
  detail?: string;
}
interface State {
  quotas: QuotaObservation[];
  policies: FailoverPolicy[];
}
interface Journal {
  schemaVersion: 1;
  events: Array<{ sequence: number; type: string; at: string; state: State }>;
}
/** Persisted normalized observations. No provider login, screen scraping or quota guessing. */
export class QuotaFailoverStore {
  private journal: Journal = { schemaVersion: 1, events: [] };
  private poisoned = false;
  constructor(private readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) {
      const loaded = JSON.parse(fs.readFileSync(file, "utf8")) as Journal;
      if (
        loaded.schemaVersion !== 1 ||
        !Array.isArray(loaded.events) ||
        !loaded.events.length
      )
        throw new Error("invalid failover journal schema");
      for (const [i, event] of loaded.events.entries()) {
        if (
          event.sequence !== i + 1 ||
          !event.type ||
          !Number.isFinite(Date.parse(event.at))
        )
          throw new Error("invalid failover journal event");
        validate(event.state);
        validateChange(
          i ? loaded.events[i - 1].state : { quotas: [], policies: [] },
          event.state,
        );
      }
      this.journal = loaded;
    }
  }
  read(): State {
    return structuredClone(
      this.journal.events.at(-1)?.state ?? { quotas: [], policies: [] },
    );
  }
  get(id: string): FailoverPolicy {
    const p = this.read().policies.find((p) => p.id === id);
    if (!p) throw new Error("failover policy not found");
    return p;
  }
  update(type: string, mutate: (state: State) => void): void {
    if (this.poisoned)
      throw new Error(
        "failover persistence failed; restart before further actions",
      );
    const state = this.read();
    mutate(state);
    validate(state);
    validateChange(this.read(), state);
    const next: Journal = {
      schemaVersion: 1,
      events: [
        ...this.journal.events,
        {
          sequence: this.journal.events.length + 1,
          type,
          at: new Date().toISOString(),
          state,
        },
      ],
    };
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(tmp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(next) + "\n");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
      if (process.platform !== "win32") {
        const fd = fs.openSync(path.dirname(this.file), "r");
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
      this.journal = next;
    } catch (error) {
      this.poisoned = true;
      throw error;
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }
}
const transitions: Record<FailoverPolicy["state"], FailoverPolicy["state"][]> =
  {
    armed: ["checkpointing", "cancelled"],
    checkpointing: ["ready", "blocked"],
    ready: ["running", "cancelled"],
    running: ["completed", "blocked"],
    blocked: ["cancelled"],
    completed: [],
    cancelled: [],
  };
function validate(s: State): void {
  if (
    !s ||
    !Array.isArray(s.quotas) ||
    !Array.isArray(s.policies) ||
    s.quotas.length > 1024 ||
    s.policies.length > 256
  )
    throw new Error("invalid or full failover registry");
  for (const q of s.quotas) {
    sessionIdentity(q.agent);
    if (
      !q.agent.workspace_id ||
      !q.agent.terminal_id ||
      !q.agent.pane_id ||
      !["available", "limited", "exhausted", "unknown"].includes(q.state) ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(q.group) ||
      !q.reportedBy?.trim() ||
      !Number.isFinite(Date.parse(q.observedAt)) ||
      !Number.isFinite(Date.parse(q.expiresAt)) ||
      Date.parse(q.expiresAt) <= Date.parse(q.observedAt)
    )
      throw new Error("invalid quota observation");
  }
  for (let i = 0; i < s.quotas.length; i++)
    if (
      s.quotas
        .slice(i + 1)
        .some((q) => sameTaskSession(q.agent, s.quotas[i].agent))
    )
      throw new Error("duplicate quota observation");
  const ids = new Set<string>();
  for (const p of s.policies) {
    sessionIdentity(p.source);
    if (
      !/^failover-[a-f0-9-]{36}$/.test(p.id) ||
      ids.has(p.id) ||
      !Object.hasOwn(transitions, p.state) ||
      !p.goal?.trim() ||
      p.goal.length > 6000 ||
      !p.source.workspace_id ||
      !p.source.terminal_id ||
      !p.source.pane_id ||
      !p.origin?.guildId ||
      !p.origin.channelId ||
      !Array.isArray(p.candidates) ||
      !p.candidates.length ||
      p.candidates.length > 16 ||
      !Number.isFinite(Date.parse(p.createdAt)) ||
      !Number.isFinite(Date.parse(p.updatedAt))
    )
      throw new Error("invalid failover policy");
    ids.add(p.id);
    const terminals = new Set([p.source.terminal_id]);
    for (const c of p.candidates) {
      sessionIdentity(c);
      if (
        !c.terminal_id ||
        !c.pane_id ||
        c.workspace_id !== p.source.workspace_id ||
        terminals.has(c.terminal_id)
      )
        throw new Error("invalid failover candidate");
      terminals.add(c.terminal_id);
    }
    if (p.checkpointId && !/^handoff-[a-f0-9-]{36}$/.test(p.checkpointId))
      throw new Error("invalid failover checkpoint");
    if (
      ["armed", "checkpointing"].includes(p.state) &&
      (p.checkpointId || p.destination)
    )
      throw new Error("premature failover execution identity");
    if (p.state === "ready" && p.destination)
      throw new Error("ready failover cannot have a destination");
    if (p.destination && !p.checkpointId)
      throw new Error("destination requires a checkpoint");
    if (["ready", "running", "completed"].includes(p.state) && !p.checkpointId)
      throw new Error("failover checkpoint required");
    if (
      p.destination &&
      !p.candidates.some((c) => sameTaskSession(c, p.destination!))
    )
      throw new Error("destination is outside frozen candidates");
    if (["running", "completed"].includes(p.state) && !p.destination)
      throw new Error("failover destination required");
  }
}
function validateChange(old: State, next: State): void {
  for (const p of old.policies) {
    const n = next.policies.find((n) => n.id === p.id);
    if (!n) throw new Error("failover policy history removed");
    for (const key of [
      "id",
      "source",
      "candidates",
      "origin",
      "goal",
      "createdAt",
    ] as const)
      if (JSON.stringify(p[key]) !== JSON.stringify(n[key]))
        throw new Error("failover policy identity changed");
    if (p.state !== n.state && !transitions[p.state].includes(n.state))
      throw new Error("invalid failover transition");
    for (const key of ["checkpointId", "destination"] as const)
      if (p[key] && JSON.stringify(p[key]) !== JSON.stringify(n[key]))
        throw new Error("failover execution identity changed");
  }
  for (const p of next.policies)
    if (!old.policies.some((v) => v.id === p.id) && p.state !== "armed")
      throw new Error("new failover policy must be armed");
}

type HandoffPort = Pick<
  SessionHandoffRuntime,
  "checkpoint" | "verify" | "accept" | "continue" | "cancel"
>;
export class QuotaFailoverManager {
  private operations = new Set<string>();
  constructor(
    readonly store: QuotaFailoverStore,
    private readonly handoffs: HandoffPort,
    private readonly live: () => Promise<AgentRecord[]>,
    private readonly allowed: string[] = [],
    private readonly now = () => Date.now(),
  ) {}
  private authorize(workspace: string): void {
    if (this.allowed.length && !this.allowed.includes(workspace))
      throw new Error("quota/failover workspace is not authorized");
  }
  private change(
    id: string,
    event: string,
    mutate: (p: FailoverPolicy) => void,
  ): FailoverPolicy {
    this.store.update(event, (s) => {
      const p = s.policies.find((p) => p.id === id)!;
      mutate(p);
      p.updatedAt = new Date(this.now()).toISOString();
    });
    return this.store.get(id);
  }
  reconcile(): void {
    for (const p of this.store
      .read()
      .policies.filter((p) => ["checkpointing", "running"].includes(p.state)))
      this.change(p.id, "restart_quarantined", (p) => {
        p.state = "blocked";
        p.detail =
          "Bridge restarted during failover; inspect linked handoff and cancel. No automatic replay.";
      });
  }
  quota(agent: AgentRecord): QuotaObservation | undefined {
    const q = this.store
      .read()
      .quotas.find((q) => sameTaskSession(q.agent, agent));
    if (
      !q ||
      Date.parse(q.observedAt) > this.now() ||
      Date.parse(q.expiresAt) <= this.now()
    )
      return;
    return q;
  }
  arm(
    source: AgentRecord,
    candidates: AgentRecord[],
    goal: string,
    origin: HandoffRecord["origin"],
  ): FailoverPolicy {
    this.authorize(source.workspace_id);
    if (!goal.trim() || goal.length > 6000)
      throw new Error("provide a goal and constraints of 1–6000 characters");
    if (
      this.store
        .read()
        .policies.some(
          (p) =>
            sameTaskSession(p.source, source) &&
            !["completed", "cancelled"].includes(p.state),
        )
    )
      throw new Error("source already has an active failover policy");
    const now = new Date(this.now()).toISOString();
    const p: FailoverPolicy = {
      id: `failover-${randomUUID()}`,
      source: structuredClone(source),
      candidates: structuredClone(candidates),
      goal: publicText(goal, 6000),
      origin: structuredClone(origin),
      state: "armed",
      createdAt: now,
      updatedAt: now,
    };
    this.store.update("failover_armed", (s) => {
      s.policies.push(p);
    });
    return this.store.get(p.id);
  }
  async report(
    agent: AgentRecord,
    state: QuotaState,
    group: string,
    by: string,
    validSeconds = 900,
  ): Promise<FailoverPolicy[]> {
    this.authorize(agent.workspace_id);
    if (
      !Number.isInteger(validSeconds) ||
      validSeconds < 30 ||
      validSeconds > 3600
    )
      throw new Error("quota observation validity must be 30–3600 seconds");
    const current = (await this.live()).find((a) => sameTaskSession(a, agent));
    if (!current) throw new Error("quota observation session changed");
    const observedAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + validSeconds * 1000).toISOString();
    this.store.update("quota_reported", (s) => {
      s.quotas = s.quotas.filter((q) => !sameTaskSession(q.agent, agent));
      s.quotas.push({
        agent: structuredClone(current),
        state,
        group,
        reportedBy: by,
        observedAt,
        expiresAt,
      });
    });
    const triggered: FailoverPolicy[] = [];
    if (!["limited", "exhausted"].includes(state)) return triggered;
    for (const p of this.store
      .read()
      .policies.filter(
        (p) => p.state === "armed" && sameTaskSession(p.source, agent),
      )) {
      if (this.operations.has(p.id)) continue;
      this.operations.add(p.id);
      try {
        this.change(p.id, "checkpoint_intent", (p) => {
          p.state = "checkpointing";
        });
        const cp = await this.handoffs.checkpoint(p.source, p.goal, p.origin);
        triggered.push(
          this.change(p.id, "checkpoint_prepared", (p) => {
            p.checkpointId = cp.id;
            p.state = "ready";
            p.detail =
              "Checkpoint prepared; run with confirm-source-stopped after verifying writers are stopped.";
          }),
        );
      } catch (error) {
        triggered.push(
          this.change(p.id, "checkpoint_blocked", (p) => {
            p.state = "blocked";
            p.detail = publicText(
              error instanceof Error ? error.message : "checkpoint failed",
              2000,
            );
          }),
        );
      } finally {
        this.operations.delete(p.id);
      }
    }
    return triggered;
  }
  private candidateAllowed(
    source: AgentRecord,
    candidate: AgentRecord,
  ): boolean {
    const from = this.quota(source);
    const to = this.quota(candidate);
    if (
      !from ||
      !["limited", "exhausted"].includes(from.state) ||
      to?.state !== "available" ||
      from.group === to.group
    )
      return false;
    // Conflicting evidence on a shared budget is conservatively unavailable.
    return !this.store
      .read()
      .quotas.some(
        (q) =>
          q.group === to.group &&
          Date.parse(q.expiresAt) > this.now() &&
          ["limited", "exhausted", "unknown"].includes(q.state),
      );
  }
  async run(id: string, by: string, stopped: boolean): Promise<FailoverPolicy> {
    const p = this.store.get(id);
    this.authorize(p.source.workspace_id);
    if (this.operations.has(id))
      throw new Error("failover operation already in progress");
    if (p.state !== "ready" || !p.checkpointId)
      throw new Error("failover requires a ready checkpoint");
    if (!stopped || !by.trim())
      throw new Error(
        "confirm-source-stopped and operator identity are required before failover",
      );
    this.operations.add(id);
    let started = false;
    try {
      const live = await this.live();
      const destination = p.candidates
        .map((c) => live.find((a) => sameTaskSession(a, c)))
        .find(
          (c) =>
            c &&
            ["idle", "done"].includes(c.agent_status) &&
            this.candidateAllowed(p.source, c),
        );
      if (!destination)
        throw new Error(
          "no eligible candidate: require fresh available quota on a different budget group and a settled exact session",
        );
      this.change(id, "failover_intent", (p) => {
        p.state = "running";
        p.destination = destination;
      });
      started = true;
      await this.handoffs.verify(p.checkpointId, destination, by, true);
      if (!this.candidateAllowed(p.source, destination))
        throw new Error(
          "quota evidence changed/expired during verification; no continuation dispatched",
        );
      await this.handoffs.accept(p.checkpointId);
      if (!this.candidateAllowed(p.source, destination))
        throw new Error("quota evidence changed/expired before continuation");
      const result = await this.handoffs.continue(p.checkpointId);
      return this.change(id, "failover_completed", (p) => {
        p.state = result.state === "completed" ? "completed" : "blocked";
        p.detail = `Handoff ${result.id}: ${result.state}. ${result.detail ?? "Inspect the handoff report for work/test evidence."}`;
      });
    } catch (error) {
      if (started)
        this.change(id, "failover_blocked", (p) => {
          p.state = "blocked";
          p.detail = publicText(
            error instanceof Error ? error.message : "failover failed",
            2000,
          );
        });
      throw error;
    } finally {
      this.operations.delete(id);
    }
  }
  async cancel(id: string): Promise<FailoverPolicy> {
    const p = this.store.get(id);
    this.authorize(p.source.workspace_id);
    if (this.operations.has(id))
      throw new Error("failover operation already in progress");
    if (["completed", "cancelled"].includes(p.state)) return p;
    this.operations.add(id);
    try {
      if (p.checkpointId) await this.handoffs.cancel(p.checkpointId);
      return this.change(id, "failover_cancelled", (p) => {
        p.state = "cancelled";
      });
    } finally {
      this.operations.delete(id);
    }
  }
}
