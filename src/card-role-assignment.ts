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
export interface RoleSnapshot {
  roles: CardRoles;
  candidates: Partial<Record<CardRole, AgentProfile[]>>;
}
export interface RoleContext {
  machineIds: readonly string[];
  profiles: readonly AgentProfile[];
  enabledProfileIds?: readonly string[];
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
      roleError(name, "未知角色");
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
      roleError(name, `不允許 agent ${agent}`);
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
  if (p.kind === "pi" && !["reviewer", "fixer"].includes(role)) return false;
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
  for (const role of CARD_ROLES) {
    const c = roles[role];
    if (!c) continue;
    if (
      c.machine &&
      c.machine !== "local" &&
      !context.machineIds.includes(c.machine)
    )
      roleError(role, `不存在 machine ${c.machine}`);
    if (c.machine && c.machine !== "local")
      roleError(role, `卡片流程尚未支援 machine ${c.machine}`);
    const kindProfiles = context.profiles.filter(
      (p) =>
        (!c.agent || p.kind === c.agent) &&
        (!context.enabledProfileIds ||
          context.enabledProfileIds.includes(p.id)),
    );
    const enabled = kindProfiles.filter((p) => roleProfileEnabled(role, p));
    if (!enabled.length)
      roleError(
        role,
        `agent ${c.agent ?? "候選"} 未開放（需要已配置可用 profile；pi Worker 尚未開放）`,
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
  }
  return { roles: structuredClone(roles), candidates };
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
  return CARD_ROLES.filter((r) => !["reviewer", "fixer"].includes(r)).flatMap(
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
      machine: constraint?.machine ? "card" : "default",
      agent: constraint?.agent ? "card" : source,
      model: constraint?.model ? "card" : "default",
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
    (!cli && !c?.agent && c?.model ? pool[0] : undefined);
  if (!p)
    roleError(role, `沒有符合 agent ${kind ?? "預設"}／model 的可用 profile`);
  return structuredClone(p);
}

/** Durable snapshots are immutable data, not authority to invent profiles/args. */
export function validateRoleSnapshot(snapshot: RoleSnapshot): void {
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
  preflightRoles(snapshot.roles, { machineIds: [], profiles: flattened });
}
