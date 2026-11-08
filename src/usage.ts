import { passiveUsage, usageKind } from "./cli-adapter.js";
import type { AgentRecord } from "./types.js";
import type { AgentProfile } from "./agent-pool.js";

/** Display-only query: its port deliberately has no send or persistence methods. */
export async function usageTable(input: {
  agents: AgentRecord[];
  workspace: string;
  target?: string;
  profiles: AgentProfile[];
  machines: Array<{ id: string; reachable: boolean }>;
  profilePane?: (id: string) => AgentRecord | undefined;
  read: (pane: string) => Promise<string>;
}): Promise<string> {
  const machineOf = (id: string) =>
    input.machines.find((m) => id.startsWith(m.id + ":"))?.id ?? "local";
  const agents = input.agents.filter((a) => a.workspace_id === input.workspace);
  const selected = input.target
    ? agents.filter((a) => a.pane_id === input.target)
    : agents;
  const profiles = input.target
    ? input.profiles.filter((p) => p.id === input.target)
    : input.profiles;
  if (input.target && selected.length + profiles.length !== 1)
    throw new Error(
      "usage target is unknown, ambiguous, or belongs to another workspace",
    );
  // Identifiers are metadata, never screen fragments, profile arguments or model/account data.
  const cell = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f|]/g, " ");
  const rows: string[] = [
    "machine | pane/profile | kind | usage | source | fetched-at",
  ];
  const row = (
    machine: string,
    target: string,
    kind: string,
    usage: string,
    source: string,
  ) =>
    rows.push(
      [machine, target, kind, usage, source, new Date().toISOString()]
        .map(cell)
        .join(" | "),
    );
  for (const a of selected) {
    const machine = machineOf(a.pane_id);
    const kind = usageKind(a.agent);
    let usage: string | undefined;
    let reason = "no readable passive usage for this CLI";
    if (input.machines.some((m) => m.id === machine && !m.reachable)) {
      reason = "unreachable; cached pane metadata only";
    } else {
      try {
        usage = passiveUsage(kind, await input.read(a.pane_id));
      } catch {
        reason = "current screen unavailable";
      }
    }
    if (!usage && ["working", "blocked"].includes(a.agent_status))
      reason += "; agent busy, passive read only";
    row(
      machine,
      a.pane_id,
      kind,
      usage ?? `unknown (${reason})`,
      usage
        ? "bottom status line (visible snapshot; CLI freshness unknown)"
        : "passive screen query",
    );
  }
  for (const p of profiles) {
    const bound = input.profilePane?.(p.id);
    if (bound && bound.workspace_id === input.workspace) {
      const table = await usageTable({
        ...input,
        agents: [bound],
        target: bound.pane_id,
        profiles: [],
        profilePane: undefined,
      });
      rows.push(
        table
          .split("\n")
          .slice(1)
          .join("\n")
          .replace(
            ` | ${cell(bound.pane_id)} | `,
            ` | profile:${p.id} (${cell(bound.pane_id)}) | `,
          ),
      );
    } else
      row(
        machineOf(input.workspace),
        `profile:${p.id}`,
        usageKind(p.kind),
        "unknown (profile has no safely identified passive usage source)",
        "profile configuration (no measurement)",
      );
  }
  if (!input.target)
    for (const m of input.machines) {
      if (!m.reachable || !agents.some((a) => machineOf(a.pane_id) === m.id))
        row(
          m.id,
          "-",
          "unknown",
          m.reachable
            ? "unknown (no Agent panes in selected authorized workspace)"
            : "unknown (unreachable)",
          "machine connection status",
        );
    }
  return rows.join("\n");
}
