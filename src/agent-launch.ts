// `agent start`：在目前選定 Agent 的 workspace 開一個新 pane，依規格啟動 Agent（console 與 Discord 共用）。

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { waitUntilReady } from "./agent-ready.js";
import { startAgentInPane, type AgentStartPort } from "./agent-start.js";
import {
  LOCAL_MACHINE,
  parseLaunchSpec,
  resolveLaunch,
  type ResolvedLaunch,
} from "./agent-launch-spec.js";
import { shellQuote, type MachineConfig } from "./machines.js";
import { closeReviewerPane, openReviewerPane } from "./review-pane.js";
import type { AgentRecord } from "./types.js";

const USAGE = "usage: agent start <machine:agent:model:level> [--cwd <path>]";
const CLI_DEFAULT = "CLI 預設";

export interface AgentStartDeps {
  port: AgentStartPort;
  /** 目前選定的 Agent（已通過 workspace 授權）。 */
  selected?: AgentRecord;
  /** workspace 路徑；白名單非空時限制 --cwd。 */
  workspacePath?: string;
  machineIds: readonly string[];
  /** 遠端 canonical path；白名單非空且在遠端時必須提供。 */
  remoteRealpath?: (machine: string, target: string) => Promise<string>;
  allowedWorkspaceIds: readonly string[];
  readyTimeoutMs?: number;
  readyPollMs?: number;
}

export function machineOfPane(paneId: string): string {
  const parts = paneId.split(":");
  return parts.length >= 3 ? parts[0]! : LOCAL_MACHINE;
}

function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const OUTSIDE =
  "allowedWorkspaceIds 非空時，--cwd 必須在選定 workspace 之內（白名單）";

/** 經 ssh 取遠端 canonical path；失敗或結果不是單行絕對路徑就丟錯誤。 */
export async function sshRealpath(
  machine: MachineConfig,
  target: string,
): Promise<string> {
  const { stdout } = await promisify(execFile)(
    "ssh",
    ["-o", "BatchMode=yes", machine.ssh, `realpath -- ${shellQuote(target)}`],
    { timeout: 10_000 },
  );
  const real = stdout.replace(/\n$/, "");
  if (!path.posix.isAbsolute(real) || /[\0-\x1f\x7f]/.test(real))
    throw new Error("unexpected realpath output");
  return real;
}

/** 與 `workspace.create` 同方向：白名單非空時，canonical path 必須在 workspace 之內。 */
async function resolveCwd(
  deps: AgentStartDeps,
  machine: string,
  requested: string | undefined,
): Promise<string> {
  const selected = deps.selected!;
  const base = selected.cwd || selected.foreground_cwd || deps.workspacePath;
  const cwd = requested ?? base;
  if (!cwd) throw new Error("選定 Agent 的工作目錄不明，請用 --cwd 指定");
  if (!path.isAbsolute(cwd) || /[\0-\x1f\x7f]/.test(cwd))
    throw new Error(`--cwd 必須是不含控制字元的絕對路徑`);
  const local = machine === LOCAL_MACHINE;
  const restricted = deps.allowedWorkspaceIds.length > 0;
  const normalized = path.normalize(cwd);
  if (!local && !restricted) return normalized;
  // 文字比對擋不住 symlink：兩邊都取 canonical path，無法驗證就拒絕。
  const canon = async (target: string) => {
    if (local) return fs.realpathSync(target);
    if (!deps.remoteRealpath) throw new Error("no remote realpath");
    return deps.remoteRealpath(machine, target);
  };
  const root = deps.workspacePath ?? base;
  let real: string;
  let realRoot: string | undefined;
  try {
    real = await canon(normalized);
    if (local && !fs.statSync(real).isDirectory()) throw new Error("not dir");
    realRoot = restricted && root ? await canon(root) : undefined;
  } catch {
    throw new Error(
      local
        ? `--cwd 不是存在的資料夾：${cwd}`
        : `無法驗證遠端 ${machine} 上 --cwd 的實際路徑，白名單非空時拒絕`,
    );
  }
  if (restricted && !(realRoot && within(realRoot, real)))
    throw new Error(OUTSIDE);
  return real;
}

export function parseAgentStartArgs(args: string[]): {
  spec: string;
  cwd?: string;
} {
  const [spec, ...rest] = args;
  if (!spec) throw new Error(USAGE);
  if (rest.length === 0) return { spec };
  if (rest[0] !== "--cwd" || rest.length < 2) throw new Error(USAGE);
  return { spec, cwd: rest.slice(1).join(" ") };
}

export async function runAgentStart(
  deps: AgentStartDeps,
  input: { spec: string; cwd?: string },
): Promise<string> {
  const { selected } = deps;
  if (!selected)
    throw new Error(
      "尚未選定 Agent：請先 `agent use <pane>`（新 pane 開在它的 workspace）",
    );
  const parsed = parseLaunchSpec(input.spec);
  if (!parsed.ok) throw new Error(parsed.error);
  const selection = {
    machine: machineOfPane(selected.pane_id),
    kind: selected.agent,
  };
  const launch = resolveLaunch(parsed.value, selection, deps.machineIds);
  if (!launch.ok) throw new Error(launch.error);
  const spec: ResolvedLaunch = launch.value;
  if (spec.machine !== selection.machine)
    throw new Error(
      `v1 只能在選定 Agent 所在的機器（${selection.machine}）啟動，不能開在 ${spec.machine}（跨機器另案）`,
    );
  const cwd = await resolveCwd(deps, spec.machine, input.cwd);

  const pane = await openReviewerPane(deps.port, {
    kind: spec.kind,
    role: "agent",
    model: spec.model,
    basePaneId: selected.pane_id,
    workspaceId: selected.workspace_id,
    cwd,
  });
  let started: AgentRecord;
  try {
    started = await startAgentInPane(deps.port, {
      skipWorkspaceTrust: true,
      paneId: pane.paneId,
      kind: spec.kind,
      name: `hdb-start-${randomUUID().slice(0, 8)}`,
      args: spec.args,
      // 只有本機 cwd 才能在本機解析 git 目錄；遠端不加。
      ...(spec.machine === LOCAL_MACHINE ? { cwd } : {}),
    });
  } catch (error) {
    const closed = await closeReviewerPane(deps.port, pane);
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new Error(
      `啟動失敗：${detail}${closed.closed ? "（新 pane 已關閉）" : `（pane ${pane.paneId} 未關閉：${closed.note}）`}`,
    );
  }
  const ready = await waitUntilReady(
    {
      panePort: deps.port,
      readyTimeoutMs: deps.readyTimeoutMs,
      readyPollMs: deps.readyPollMs,
    },
    pane,
    started,
  );
  // 不就緒時保留 pane（可能在等信任提示），由使用者處理，不替人確認。
  if (!ready.ok)
    throw new Error(
      `${ready.reason.replace(/reviewer/g, "Agent")}。pane：${pane.paneId}（未關閉，請到該 pane 處理）`,
    );
  const got = ready.agent;
  if (
    got.agent !== spec.kind ||
    got.workspace_id !== selected.workspace_id ||
    got.pane_id !== pane.paneId ||
    got.terminal_id !== pane.terminalId
  )
    throw new Error(
      `啟動的 Agent 與要求不符（偵測到 ${got.agent ?? "?"}），pane ${pane.paneId} 未關閉，請檢查`,
    );
  return [
    `✅ 已啟動 Agent：pane \`${ready.agent.pane_id}\``,
    `機器：${spec.machine} · 種類：${spec.kind} · model：${spec.model ?? CLI_DEFAULT} · level：${spec.level ?? CLI_DEFAULT}`,
    `工作目錄：${cwd}`,
    ...(spec.kind === "agy" && spec.machine !== LOCAL_MACHINE
      ? ["remote agy trust needs manual handling／遠端 agy 的信任需人工處理"]
      : []),
    `未自動切換；要使用請 \`agent use ${ready.agent.pane_id}\`。`,
  ].join("\n");
}
