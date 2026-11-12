/** Card-only constraints. Legacy cards never enter this resolver. */
import { validateProfiles, type AgentProfile } from "./agent-pool.js";
import type { AgentRecord } from "./types.js";
import type { RoleIdentity } from "./card-events.js";

export const CARD_ROLES = [
  "implement",
  "diagnose",
  "review",
  "verify",
  "reviewer",
  "fixer",
] as const;
export type CardRole = (typeof CARD_ROLES)[number];
export type SelectionSource = "card" | "lead" | "default" | "CLI";
export interface RoleConstraint {
  machine?: string;
  agent?: string;
  model?: string;
}
export type CardRoles = Partial<Record<CardRole, RoleConstraint>>;
/** `machines[].cardReview` 開放的遠端 id 與 kinds；toolchain 才可分配 verify。 */
export type RemoteReviewMachine = { id: string; kinds: readonly string[]; toolchain?: boolean };
/** task 內可以派到遠端的角色；都是唯讀，implement／fixer 不在內。 */
export const REMOTE_TASK_ROLES = ["diagnose", "review", "verify"] as const;
export interface RoleSnapshot {
  roles: CardRoles;
  candidates: Partial<Record<CardRole, AgentProfile[]>>;
  /** reviewer 指到遠端時凍結的開放條件；舊快照沒有＝只有 local。 */
  remoteMachines?: RemoteReviewMachine[];
}
export interface RoleContext {
  machineIds: readonly string[];
  profiles: readonly AgentProfile[];
  enabledProfileIds?: readonly string[];
  remoteMachines?: readonly RemoteReviewMachine[];
}
export const CARD_MODEL = /^[A-Za-z0-9][A-Za-z0-9_./:+-]{0,79}$/;
const KINDS = ["claude", "codex", "agy", "pi"];
export function roleError(role: string, reason: string): never {
  throw new Error(`卡片角色指定無效：${role}：${reason}`);
}
export function parseCardRoles(value: unknown): CardRoles {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.keys(value).length
  )
    roleError("roles", "必須是非空 inline map");
  const roles: CardRoles = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!(CARD_ROLES as readonly string[]).includes(name))
      roleError("roles", "未知角色");
    if (typeof raw !== "string" || !raw)
      roleError(name, "必須是 machine:agent:model 字串");
    const first = raw.indexOf(":");
    const second = first < 0 ? -1 : raw.indexOf(":", first + 1);
    const machine = (first < 0 ? raw : raw.slice(0, first)) || undefined;
    const agent =
      (first < 0
        ? ""
        : second < 0
          ? raw.slice(first + 1)
          : raw.slice(first + 1, second)) || undefined;
    const model = (second < 0 ? "" : raw.slice(second + 1)) || undefined;
    if (!machine && !agent && !model) roleError(name, "不可全部省略");
    if (machine && !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(machine))
      roleError(name, "不合法 machine");
    if (agent && !KINDS.includes(agent))
      roleError(name, "不允許 agent");
    if (model && !CARD_MODEL.test(model))
      roleError(name, "不合法 model（英數起頭、最多80字）");
    roles[name as CardRole] = {
      ...(machine ? { machine } : {}),
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
    };
  }
  return roles;
}
export function serializeCardRoles(roles: CardRoles): Record<string, string> {
  return Object.fromEntries(
    CARD_ROLES.filter((r) => roles[r]).map((r) => {
      const c = roles[r]!;
      return [r, `${c.machine ?? ""}:${c.agent ?? ""}:${c.model ?? ""}`];
    }),
  );
}
/** Configured args must never resume a session or override the selected model. */
export function assertFreshProfile(profile: AgentProfile): void {
  if (
    profile.modelFlag &&
    /^--?(?:resume|continue|session(?:-id)?|conversation(?:-id)?|r|c)$/i.test(
      profile.modelFlag,
    )
  )
    throw new Error(
      `profile ${profile.id} 的 modelFlag 不可 resume／綁定既有 session`,
    );
  for (const arg of profile.args ?? []) {
    if (
      /^(?:resume|continue|attach)$/i.test(arg) ||
      /^--?(?:resume|continue|session(?:-id)?|conversation(?:-id)?|fork-session|resume-session|session-file|model|m|r|c)(?:=|$)/i.test(
        arg,
      ) ||
      (profile.modelFlag &&
        (arg === profile.modelFlag || arg.startsWith(`${profile.modelFlag}=`)))
    )
      throw new Error(
        `profile ${profile.id} 的 args 不可 resume／綁定既有 session 或覆寫 model`,
      );
  }
}
export function roleProfileEnabled(role: CardRole, p: AgentProfile): boolean {
  if (!KINDS.includes(p.kind)) return false;
  if (["claude", "codex"].includes(p.kind)) return true;
  return !!p.capabilities?.some(
    (c) => c === "implementation" || c === "review",
  );
}
export function preflightRoles(
  roles: CardRoles,
  context: RoleContext,
): RoleSnapshot {
  // Revalidate persisted/untrusted objects via the same canonical grammar.
  for (const [name, c] of Object.entries(roles)) {
    if (
      !(CARD_ROLES as readonly string[]).includes(name) ||
      !c ||
      typeof c !== "object" ||
      Array.isArray(c) ||
      Object.keys(c).some((k) => !["machine", "agent", "model"].includes(k)) ||
      Object.values(c).some((v) => typeof v !== "string" || !v)
    )
      roleError(name, "不合法角色欄位");
  }
  roles = parseCardRoles(serializeCardRoles(roles));
  const candidates: RoleSnapshot["candidates"] = {};
  const remoteMachines: RemoteReviewMachine[] = [];
  for (const role of CARD_ROLES) {
    const c = roles[role];
    if (!c) continue;
    if (
      c.machine &&
      c.machine !== "local" &&
      !context.machineIds.includes(c.machine)
    )
      roleError(role, `不存在 machine ${c.machine}`);
    const remote = c.machine?.replace(/^local$/, "") && remoteReviewMachine(role, c, context);
    const kindProfiles = context.profiles.filter(
      (p) =>
        (!c.agent || p.kind === c.agent) &&
        (!remote || remote.kinds.includes(p.kind)) &&
        (!context.enabledProfileIds ||
          context.enabledProfileIds.includes(p.id)),
    );
    const enabled = kindProfiles.filter((p) => roleProfileEnabled(role, p));
    if (!enabled.length)
      roleError(
        role,
        `agent ${c.agent ?? "候選"} 未開放（需要已配置且符合角色開放條件的 profile）`,
      );
    const matches = enabled.filter((p) => !c.model || p.model === c.model);
    if (!matches.length)
      roleError(
        role,
        `不合法 model ${c.model}（須在同 kind 已開放 profile 的配置允許清單）`,
      );
    for (const p of matches) {
      assertFreshProfile(p);
      if (p.model && (!CARD_MODEL.test(p.model) || !p.modelFlag))
        roleError(role, `profile ${p.id} 的 model／modelFlag 不合法`);
    }
    candidates[role] = structuredClone(matches);
    if (remote && !remoteMachines.some((m) => m.id === remote.id))
      remoteMachines.push({ id: remote.id, kinds: [...remote.kinds], ...(remote.toolchain ? { toolchain: true } : {}) });
  }
  return { roles: structuredClone(roles), candidates, ...(remoteMachines.length ? { remoteMachines } : {}) };
}
function remoteReviewMachine(role: CardRole, c: RoleConstraint, context: RoleContext): RemoteReviewMachine {
  const unsupported = `卡片流程尚未支援 machine ${c.machine}`;
  if (role === "implement" || role === "fixer") roleError(role, `remote 寫入尚未支援：${unsupported} 的寫入角色`);
  const remote = context.remoteMachines?.find((m) => m.id === c.machine);
  if (!remote || (c.agent && !remote.kinds.includes(c.agent))) roleError(role, `machine 未開放卡片 review（${c.machine}）`);
  if (role === "verify" && !remote.toolchain) roleError(role, `remote verify 不可用：machine ${c.machine} 沒有工具鏈`);
  return remote;
}
/** Lead 候選；沒有工具鏈的 verify 標 unavailable。 */
export function remoteRoleCandidates(context: RoleContext) {
  return (context.remoteMachines ?? []).flatMap((m) =>
    REMOTE_TASK_ROLES.flatMap((role) =>
      context.profiles
        .filter((p) => m.kinds.includes(p.kind) && roleProfileEnabled(role, p) && (context.enabledProfileIds?.includes(p.id) ?? true))
        .map((p) => ({
          machine: m.id,
          role,
          kind: p.kind,
          profileId: p.id,
          ...(p.model ? { model: p.model } : {}),
          available: role !== "verify" || !!m.toolchain,
          ...(role === "verify" && !m.toolchain ? { reason: "no toolchain on machine" } : {}),
        })),
    ),
  );
}
const REMOTE_TARGET = /^remote:([A-Za-z][A-Za-z0-9_-]{1,31}):(diagnose|review|verify):([a-z][a-z0-9_-]{0,31})$/;
export function parseRemoteTarget(paneId: string) {
  const m = REMOTE_TARGET.exec(paneId);
  return m ? { machine: m[1]!, role: m[2] as (typeof REMOTE_TASK_ROLES)[number], profileId: m[3]! } : undefined;
}
/** 取得時才在 pod 建快照與 session。 */
export function remoteRoleTargets(context: RoleContext, workspace: string): AgentRecord[] {
  return remoteRoleCandidates(context)
    .filter((c) => c.available)
    .map((c) => {
      const id = `remote:${c.machine}:${c.role}:${c.profileId}`;
      return {
        pane_id: id,
        terminal_id: id,
        workspace_id: workspace,
        tab_id: "",
        agent: c.kind,
        agent_status: "idle",
        machine: c.machine,
        model: c.model,
        profile: structuredClone(context.profiles.find((p) => p.id === c.profileId)),
        roleTarget: c.role,
      };
    });
}
/** pod 上的 Worker 只在 roster 有同機器 remote target 時算 Team 成員。 */
export function teamMember(agent: AgentRecord, workspaceId: string, roster: readonly AgentRecord[]): boolean {
  if (agent.workspace_id === workspaceId) return true;
  const machine = machineOfActor(agent);
  return (
    machine !== "local" &&
    agent.pane_id.startsWith(`${machine}:`) &&
    agent.workspace_id.startsWith(`${machine}:`) &&
    roster.some((r) => r.machine === machine && parseRemoteTarget(r.pane_id)?.machine === machine)
  );
}
/** 卡片 reviewer 在 remote、沒宣告 review 時，task 內 review 也必須在同一台（ISSUE-150）。 */
export function roleConstraint(snapshot: RoleSnapshot, role: CardRole): RoleConstraint | undefined {
  const reviewer = snapshot.roles.reviewer;
  if (snapshot.roles[role]) return snapshot.roles[role];
  return role === "review" && reviewer?.machine && reviewer.machine !== "local" ? structuredClone(reviewer) : undefined;
}
/** Lead 候選：每個開放遠端上的可用 reviewer profile，標明 machine。 */
export function remoteReviewerCandidates(context: RoleContext) {
  return (context.remoteMachines ?? []).flatMap((m) =>
    context.profiles
      .filter((p) => m.kinds.includes(p.kind) && roleProfileEnabled("reviewer", p) && (context.enabledProfileIds?.includes(p.id) ?? true))
      .map((p) => ({ machine: m.id, kind: p.kind, profileId: p.id, ...(p.model ? { model: p.model } : {}) })),
  );
}
export function machineOfActor(actor: AgentRecord): string {
  return typeof actor.machine === "string"
    ? actor.machine
    : actor.pane_id.split(":").length >= 3
      ? actor.pane_id.split(":")[0]!
      : "local";
}
export function assertRoleMatches(
  role: CardRole,
  c: RoleConstraint,
  actor: AgentRecord,
): void {
  // Card execution is local even when machine is omitted.
  if (machineOfActor(actor) !== (c.machine ?? "local"))
    roleError(
      role,
      `派工不符：machine 預期 ${c.machine ?? "local"}，實際 ${machineOfActor(actor)}`,
    );
  if (c.agent && actor.agent !== c.agent)
    roleError(role, `派工不符：agent 預期 ${c.agent}，實際 ${actor.agent}`);
  if (c.model && actor.model !== c.model)
    roleError(
      role,
      `派工不符：model 預期 ${c.model}，實際 ${actor.model ?? "未知"}`,
    );
}
export function roleTargets(
  snapshot: RoleSnapshot,
  workspace: string,
): AgentRecord[] {
  // 宣告在 remote 的角色只能用 remote target。
  return CARD_ROLES.filter((r) => !["reviewer", "fixer"].includes(r) && !snapshot.roles[r]?.machine?.replace(/^local$/, "")).flatMap(
    (role) =>
      (snapshot.candidates[role] ?? []).map((p) => ({
        pane_id: `role:${role}:${p.id}`,
        terminal_id: `role:${role}:${p.id}`,
        workspace_id: workspace,
        tab_id: "",
        agent: p.kind,
        agent_status: "idle",
        machine: "local",
        model: p.model,
        profile: p,
        roleTarget: role,
      })),
  );
}
export function roleMetadata(
  role: CardRole,
  constraint: RoleConstraint | undefined,
  actor: AgentRecord,
  source: SelectionSource,
  evidence: "launch" | "observed" | "unknown",
): Partial<RoleIdentity> {
  return {
    source: constraint ? "card" : source,
    selectionSources: {
      machine: constraint?.machine ? "card" : machineOfActor(actor) !== "local" ? source : "default",
      agent: constraint?.agent ? "card" : source,
      model: constraint?.model
        ? "card"
        : source === "lead" && actor.model
          ? "lead"
          : "default",
    },
    modelEvidence: actor.model ? evidence : "unknown",
    ...(["implement", "diagnose", "review", "verify"].includes(role)
      ? { codingRole: role as "implement" | "diagnose" | "review" | "verify" }
      : {}),
  };
}
export function resolveFlowRole(
  snapshot: RoleSnapshot,
  role: "reviewer" | "fixer",
  fallbackKind: string | undefined,
  cli?: string,
): AgentProfile {
  const c = snapshot.roles[role];
  if (c?.agent && cli && cli !== c.agent)
    roleError(role, `CLI agent ${cli} 與卡片 ${c.agent} 衝突`);
  const kind = c?.agent ?? cli ?? fallbackKind;
  const pool = snapshot.candidates[role] ?? [];
  const p =
    pool.find((p) => !kind || p.kind === kind) ??
    (!cli && !c?.agent ? pool[0] : undefined);
  if (!p)
    roleError(role, `沒有符合 agent ${kind ?? "預設"}／model 的可用 profile`);
  return structuredClone(p);
}

/** Durable snapshots are immutable data, not authority to invent profiles/args. */
export function validateRoleSnapshot(snapshot: RoleSnapshot): void {
  const remote = snapshot.remoteMachines;
  const machineOk = (m: RemoteReviewMachine) =>
    ["id,kinds", "id,kinds,toolchain"].includes(Object.keys(m ?? 0).join()) && (m.toolchain ?? true) === true && /^(?!local$)[A-Za-z][\w-]{1,31}$/.test(m.id) && m.kinds?.length && m.kinds.every((k) => KINDS.includes(k));
  if (remote && !(Array.isArray(remote) && remote.length && remote.length <= 8 && remote.every(machineOk)))
    throw new Error("invalid role remote machines");
  const names = Object.keys(snapshot.roles);
  if (Object.keys(snapshot.candidates).some((k) => !names.includes(k)))
    throw new Error("invalid role candidates");
  const flattened: AgentProfile[] = [];
  for (const role of names) {
    const list = snapshot.candidates[role as CardRole];
    if (!Array.isArray(list) || !list.length || list.length > 64)
      throw new Error("invalid role candidates");
    for (const p of list) {
      const [validated] = validateProfiles([p]);
      if (!validated || !roleProfileEnabled(role as CardRole, validated))
        throw new Error("invalid role profile");
      assertFreshProfile(validated);
      const c = snapshot.roles[role as CardRole]!;
      if ((c.agent && p.kind !== c.agent) || (c.model && p.model !== c.model))
        throw new Error("role candidate conflicts with constraint");
      flattened.push(validated);
    }
  }
  // 凍結的遠端開放條件一起重驗；多出或少了都拒絕。
  const machines = remote ?? [];
  const checked = preflightRoles(snapshot.roles, { machineIds: machines.map((m) => m.id), profiles: flattened, remoteMachines: machines });
  if (JSON.stringify(checked.remoteMachines ?? []) !== JSON.stringify(machines)) throw new Error("invalid role remote machines");
}
