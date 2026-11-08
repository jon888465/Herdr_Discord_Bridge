import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentRecord } from "./types.js";
import type { HerdrClient } from "./herdr.js";
import { hasAgentSession, sameAgentSession } from "./response-stream.js";

export interface AgentProfile {
  id: string;
  kind: string;
  model?: string;
  modelFlag?: string;
  args?: string[];
  capabilities?: string[];
}
interface Binding {
  paneId?: string;
  agent?: AgentRecord;
  fingerprint: string;
  uncertain?: boolean;
}
interface PoolState {
  teams: Record<string, string[]>;
  sessions: Record<string, Binding>;
}
type Port = Pick<HerdrClient, "listAgentsWithWorkspaceNames" | "startProfile">;
export interface Acquisition {
  agent: AgentRecord;
  continuity: "same-session" | "new-session" | "unknown";
}

export function validateProfiles(value: unknown): AgentProfile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64)
    throw new Error("agentProfiles must be an array of at most 64 profiles");
  const ids = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== "object")
      throw new Error("invalid Agent profile");
    const p = raw as AgentProfile;
    if (
      typeof p.id !== "string" ||
      !/^[a-z][a-z0-9_-]{0,31}$/.test(p.id) ||
      ids.has(p.id)
    )
      throw new Error("Agent profile IDs must be unique lowercase names");
    if (typeof p.kind !== "string" || !/^[a-z][a-z0-9_-]*$/.test(p.kind))
      throw new Error(`invalid kind for profile ${p.id}`);
    for (const list of [p.args, p.capabilities])
      if (
        list !== undefined &&
        (!Array.isArray(list) ||
          list.length > 32 ||
          list.some(
            (v) => typeof v !== "string" || v.includes("\0") || v.length > 1000,
          ))
      )
        throw new Error(`invalid args/capabilities for profile ${p.id}`);
    if (
      p.model !== undefined &&
      (typeof p.model !== "string" ||
        !p.model ||
        p.model.length > 200 ||
        /[\r\n\0]/.test(p.model))
    )
      throw new Error(`invalid model for profile ${p.id}`);
    const modelFlag =
      p.modelFlag ??
      (p.kind === "codex" ? "-m" : p.kind === "claude" ? "--model" : undefined);
    if (
      (p.model && !modelFlag) ||
      (modelFlag && !/^--?[a-z][a-z-]*$/.test(modelFlag))
    )
      throw new Error(
        `profile ${p.id} requires a valid modelFlag for this CLI`,
      );
    ids.add(p.id);
    return {
      id: p.id,
      kind: p.kind,
      model: p.model,
      modelFlag,
      args: p.args ?? [],
      capabilities: p.capabilities ?? [],
    };
  });
}

/** Persisted team permissions and session identities; release preserves CLI context. */
export class AgentPool {
  private state: PoolState = { teams: {}, sessions: {} };
  private launchQueue: Promise<void> = Promise.resolve();
  private pending = new Set<string>();
  private leases = new Map<string, string>();
  readonly profiles: AgentProfile[];
  constructor(
    private readonly file: string,
    profiles: AgentProfile[],
    private readonly herdr: Port,
    private readonly allowed: string[],
    /** ISSUE-091：`agent.start` 回傳後 Agent 還要幾秒才被偵測到並就緒，最多等多久。 */
    private readonly readyTimeoutMs = 30000,
  ) {
    this.profiles = validateProfiles(profiles);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as PoolState;
      if (!data.teams || !data.sessions)
        throw new Error(
          "invalid Agent pool state; refusing to discard session ownership",
        );
      this.state = data;
    }
  }
  private authorize(workspace: string): void {
    if (this.allowed.length && !this.allowed.includes(workspace))
      throw new Error("workspace is not authorized");
  }
  private profile(id: string): AgentProfile {
    const profile = this.profiles.find((p) => p.id === id);
    if (!profile) throw new Error(`unknown Agent profile: ${id}`);
    return profile;
  }
  members(workspace: string): string[] {
    this.authorize(workspace);
    return [...(this.state.teams[workspace] ?? [])];
  }
  select(workspace: string, id: string, enabled: boolean): void {
    this.authorize(workspace);
    this.profile(id);
    if (
      this.leases.has(`${workspace}/${id}`) ||
      this.pending.has(`${workspace}/${id}`)
    )
      throw new Error("profile is in use by a task");
    const ids = new Set(this.members(workspace));
    if (enabled) ids.add(id);
    else ids.delete(id);
    this.state.teams[workspace] = [...ids];
    this.save();
  }
  selectAll(workspace: string, ids: string[]): void {
    this.authorize(workspace);
    for (const id of ids) this.profile(id);
    const old = new Set(this.members(workspace));
    const next = new Set(ids);
    for (const id of new Set([...old, ...next])) {
      if (old.has(id) === next.has(id)) continue;
      const key = `${workspace}/${id}`;
      if (this.leases.has(key) || this.pending.has(key))
        throw new Error("profile is in use by a task");
    }
    this.state.teams[workspace] = [...next];
    this.save();
  }
  roster(workspace: string): AgentRecord[] {
    return this.members(workspace).map((id) => {
      const p = this.profile(id);
      return {
        pane_id: `profile:${id}`,
        terminal_id: `profile:${id}`,
        workspace_id: workspace,
        tab_id: "",
        agent: p.kind,
        agent_name: id,
        agent_status: "idle",
        profile: p,
      };
    });
  }
  /** Read-only profile lookup; uncertain/stale identities must not supply usage. */
  passiveProfilePane(
    workspace: string,
    id: string,
    live: AgentRecord[],
  ): AgentRecord | undefined {
    if (this.allowed.length && !this.allowed.includes(workspace)) return;
    const profile = this.profiles.find((p) => p.id === id);
    const binding = this.state.sessions[`${workspace}/${id}`];
    if (
      !profile ||
      !binding?.agent ||
      !hasAgentSession(binding.agent.agent_session) ||
      binding.uncertain ||
      binding.fingerprint !== JSON.stringify(profile)
    )
      return;
    return live.find(
      (a) =>
        a.workspace_id === workspace &&
        a.pane_id === binding.paneId &&
        a.terminal_id === binding.agent!.terminal_id &&
        a.agent === profile.kind &&
        sameAgentSession(a.agent_session, binding.agent!.agent_session),
    );
  }

  async describe(workspace: string): Promise<string> {
    const selected = this.members(workspace);
    const live = await this.herdr.listAgentsWithWorkspaceNames();
    return (
      this.profiles
        .map((p) => {
          const b = this.state.sessions[`${workspace}/${p.id}`];
          const a = live.find(
            (v) => v.pane_id === b?.paneId && v.workspace_id === workspace,
          );
          const state = b?.uncertain
            ? "startup uncertain; bind after inspection"
            : a
              ? `${a.agent_status} · ${a.pane_id} · session ${knownSession(a) ? "identified" : "unknown"}`
              : b
                ? "stale session"
                : "not started";
          return `[${selected.includes(p.id) ? "x" : " "}] ${p.id} · ${p.kind}${p.model ? ` / ${p.model}` : ""} · ${state}`;
        })
        .join("\n") ||
      "No profiles configured. Add agentProfiles to config.json."
    );
  }
  bind(workspace: string, id: string, agent: AgentRecord): void {
    this.authorize(workspace);
    const p = this.profile(id);
    const key = `${workspace}/${id}`;
    if (!this.members(workspace).includes(id))
      throw new Error("profile is not enabled for this Team");
    if (this.pending.has(key) || this.leases.has(key))
      throw new Error("profile is in use by a task");
    if (agent.workspace_id !== workspace || agent.agent !== p.kind)
      throw new Error("profile kind/workspace does not match Agent");
    if (!["idle", "done"].includes(agent.agent_status))
      throw new Error("Agent is busy or blocked");
    if (
      Object.entries(this.state.sessions).some(
        ([k, b]) => k !== key && b.paneId === agent.pane_id,
      )
    )
      throw new Error("pane already belongs to another profile");
    this.state.sessions[key] = {
      paneId: agent.pane_id,
      agent: structuredClone(agent),
      fingerprint: JSON.stringify(p),
    };
    this.save();
  }
  async acquire(
    workspace: string,
    id: string,
    lead: AgentRecord,
    owner: string,
  ): Promise<Acquisition> {
    this.authorize(workspace);
    const p = this.profile(id);
    const key = `${workspace}/${id}`;
    if (!this.members(workspace).includes(id))
      throw new Error("profile is not enabled for this Team");
    if (lead.workspace_id !== workspace)
      throw new Error("Lead workspace mismatch");
    if (
      this.pending.has(key) ||
      (this.leases.has(key) && this.leases.get(key) !== owner)
    )
      throw new Error("profile is leased by another task");
    this.pending.add(key);
    try {
      const binding = this.state.sessions[key];
      if (binding?.uncertain)
        throw new Error(
          "previous startup delivery is uncertain; inspect and explicitly bind a live Agent before retrying",
        );
      if (binding && binding.fingerprint !== JSON.stringify(p))
        throw new Error(
          "profile configuration changed; explicitly bind the desired session",
        );
      const live = await this.herdr.listAgentsWithWorkspaceNames();
      const prior = live.find((a) => a.pane_id === binding?.paneId);
      if (prior) {
        if (
          prior.workspace_id !== workspace ||
          prior.agent !== p.kind ||
          prior.pane_id === lead.pane_id ||
          prior.terminal_id !== binding?.agent?.terminal_id ||
          !sameAgentSession(prior.agent_session, binding.agent.agent_session)
        )
          throw new Error(
            "bound session identity changed; explicitly bind after inspection",
          );
        if (!["idle", "done"].includes(prior.agent_status))
          throw new Error(`profile Agent is ${prior.agent_status}`);
        this.leases.set(key, owner);
        return {
          agent: prior,
          continuity: knownSession(prior) ? "same-session" : "unknown",
        };
      }
      // Serialize layout changes and persist uncertainty immediately before mutation.
      const markStarting = () => {
        this.state.sessions[key] = {
          fingerprint: JSON.stringify(p),
          uncertain: true,
        };
        this.save();
      };
      const launch = this.launchQueue.then(() =>
        this.herdr.startProfile(
          lead,
          p,
          `hdb-${randomUUID().slice(0, 16)}`,
          (paneId) => {
            this.state.sessions[key] = {
              fingerprint: JSON.stringify(p),
              uncertain: true,
              paneId,
            };
            this.save();
          },
          markStarting,
        ),
      );
      this.launchQueue = launch.then(
        () => undefined,
        () => undefined,
      );
      const agent = await this.waitUntilReady(await launch, p.kind);
      if (
        agent.workspace_id !== workspace ||
        agent.agent !== p.kind ||
        agent.pane_id === lead.pane_id ||
        !["idle", "done"].includes(agent.agent_status)
      )
        throw new Error(
          "started Agent does not match requested profile/workspace or is not ready",
        );
      this.state.sessions[key] = {
        paneId: agent.pane_id,
        agent: structuredClone(agent),
        fingerprint: JSON.stringify(p),
      };
      this.save();
      this.leases.set(key, owner);
      return { agent, continuity: "new-session" };
    } finally {
      this.pending.delete(key);
    }
  }
  /**
   * ISSUE-091：Herdr 的 `agent.start` 在約 1 秒內就回傳，這時新 pane 還沒被偵測成這個 CLI
   * （沒有 agent 欄位、狀態 unknown），要約 2 到 8 秒後才變成 idle。在這段期間內持續重讀同一個 pane，
   * 直到偵測到預期的 CLI 且 idle／done；逾時就回傳最後一次看到的狀態，讓原本的檢查丟出錯誤。
   * 偵測成別的 CLI 時不再等（身分不符是真正的錯誤）。
   */
  private async waitUntilReady(
    started: AgentRecord,
    kind: string,
  ): Promise<AgentRecord> {
    const deadline = Date.now() + this.readyTimeoutMs;
    let current = started;
    for (;;) {
      if (current.agent && current.agent !== kind) return current;
      if (
        current.agent === kind &&
        ["idle", "done"].includes(current.agent_status)
      )
        return current;
      if (Date.now() >= deadline) return current;
      await delay(300);
      const found = (await this.herdr.listAgentsWithWorkspaceNames()).find(
        (a) => a.pane_id === started.pane_id,
      );
      if (found) current = found;
    }
  }
  /**
   * ISSUE-107：agy 啟動時沒有 session，處理完第一個回合後才被 Herdr 登記。回合結果已經核對過 session 全程一致
   * （`runTeamTurn`），這裡再確認：呼叫者持有這個 profile 的保留、綁定仍是同一個 pane／terminal／workspace／
   * 種類／設定、綁定原本沒有 session，而且目前活著的 pane 回報的正是這個 session，才把它寫進綁定。
   * 已有 session 的綁定不會被取代（回傳 false）；codex 的 Herdr session 不可信，
   * 不採用。任何一項不符都回傳 false 且不改狀態；unknown → known 不會在任意 acquire 時被接受。
   */
  async refreshSession(
    workspace: string,
    id: string,
    owner: string,
    worker: AgentRecord,
    session: { kind: string; value: string },
  ): Promise<boolean> {
    if (this.allowed.length && !this.allowed.includes(workspace)) return false;
    const p = this.profiles.find((profile) => profile.id === id);
    if (!p) return false;
    const key = `${workspace}/${id}`;
    if (p.kind.toLowerCase().includes("codex")) return false;
    if (this.leases.get(key) !== owner) return false;
    const binding = this.state.sessions[key];
    if (
      !binding?.agent ||
      binding.uncertain ||
      hasAgentSession(binding.agent.agent_session) ||
      binding.fingerprint !== JSON.stringify(p) ||
      binding.paneId !== worker.pane_id ||
      binding.agent.terminal_id !== worker.terminal_id ||
      binding.agent.workspace_id !== workspace ||
      binding.agent.agent !== p.kind ||
      worker.workspace_id !== workspace ||
      binding.agent.pane_id !== worker.pane_id ||
      worker.agent !== p.kind ||
      !hasAgentSession(session)
    )
      return false;
    const snapshot = JSON.stringify(binding);
    const live = (await this.herdr.listAgentsWithWorkspaceNames()).find(
      (a) => a.pane_id === binding.paneId,
    );
    if (
      this.leases.get(key) !== owner ||
      this.state.sessions[key] !== binding ||
      JSON.stringify(binding) !== snapshot ||
      JSON.stringify(p) !== binding.fingerprint ||
      !live ||
      live.workspace_id !== workspace ||
      live.terminal_id !== binding.agent.terminal_id ||
      live.agent !== p.kind ||
      !sameAgentSession(live.agent_session, session)
    )
      return false;
    binding.agent = { ...binding.agent, agent_session: live.agent_session };
    this.save();
    return true;
  }
  release(owner: string): void {
    for (const [key, lease] of this.leases)
      if (lease === owner) this.leases.delete(key);
  }
  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2) + "\n", {
      mode: 0o600,
    });
    fs.renameSync(tmp, this.file);
  }
}
function knownSession(agent: AgentRecord): boolean {
  const s = agent.agent_session as
    { kind?: unknown; value?: unknown } | undefined;
  return (
    !!s &&
    typeof s.kind === "string" &&
    typeof s.value === "string" &&
    !!s.value
  );
}
