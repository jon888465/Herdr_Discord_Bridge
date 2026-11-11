// 卡片 remote reviewer（REQ-20261111-remote-agy-role）。RemoteFailure.label 是可進紀錄的固定分類，detail 只進 console。

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { startAgentInPane, type AgentStartPort } from "./agent-start.js";
import { runCardReview, type ReviewFlowDeps, type ReviewFlowInput, type ReviewFlowResult } from "./card-review-flow.js";
import { BLOCKED_AT_START } from "./agent-ready.js";
import { defaultExec } from "./github.js";
import { shellQuote, unsafeRemoteValue, type HerdrHub, type MachineConfig } from "./machines.js";

export type RemoteExec = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: string }>;

/** uncertain：遠端可能還在跑，不可立刻清理。 */
export class RemoteFailure extends Error {
  constructor(
    readonly label: string,
    readonly detail = label,
    readonly uncertain = false,
  ) {
    super(label);
  }
}

const LONG_MS = 5 * 60 * 1000;
const SHORT_MS = 30_000;
export const LOCAL_GRACE_MS = 20_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA = /^[0-9a-f]{40}$/;
const GIT = ["git", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "core.hooksPath=/dev/null"];
/** 即使 ~/.ssh/config 開了也不轉送。 */
export const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes"];

export function assertRemoteValue(name: string, value: unknown): string {
  const problem = unsafeRemoteValue(value);
  if (problem) throw new RemoteFailure("參數不合法", `${name}：${problem}`);
  return value as string;
}

const LABEL_ATTEMPTS = 3;
const LABEL_RECHECK_MS = 2000;

/**
 * 固定分類白名單（flow 與 agent-ready 產生、不含機器或遠端輸出）；字串是完整比對，RegExp 附 sample 供測試逐項斷言。
 * BLOCKED_AT_START 本身含「：」（「常見原因：…」），所以先比完整字串，再比「：」前的固定標籤。
 */
export const RESULT_WHITELIST: readonly (string | { re: RegExp; sample: string })[] = [
  "無法取得工作樹指紋，不開始 review",
  BLOCKED_AT_START,
  "reviewer 卡在啟動提示，已保留 pane 供人處理",
  "reviewer 卡住了（blocked，可能在等人確認）",
  "reviewer 沒有回覆",
  "review 之後無法確認工作樹沒被改動",
  "reviewer 改動了工作樹（review 前後的指紋不同），整份 review 不採用",
  { re: /^reviewer 在 \d+ 秒內沒有就緒（狀態 [a-z_]+）$/, sample: "reviewer 在 30 秒內沒有就緒（狀態 idle）" },
  "等待 reviewer 就緒時讀取 Agent 清單失敗",
  "等待 reviewer 就緒時，它的 pane 不見了（消失或被換掉）",
  "cleanup_pending",
];
const whitelisted = (text: string) => RESULT_WHITELIST.some((e) => (typeof e === "string" ? e === text : e.re.test(text)));
export const UNCLASSIFIED = "遠端 review 失敗：未分類";

/** 只放行白名單內的完整文字，或「：」前在白名單內的標籤，其餘一律未分類。 */
export function fixedResultText(text: string): string {
  if (whitelisted(text)) return text;
  const head = text.split("：")[0]!;
  return whitelisted(head) ? head : UNCLASSIFIED;
}

export function githubOriginRepo(url: string): { owner: string; repo: string } | undefined {
  if (unsafeRemoteValue(url)) return undefined;
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(url);
  if (!match || !NAME.test(match[2]!)) return undefined;
  return { owner: match[1]!, repo: match[2]! };
}

export function cardHash(cardId: string): string {
  return createHash("sha256").update(cardId).digest("hex").slice(0, 10);
}

export function remoteCheckoutDir(root: string, owner: string, repo: string, cardId: string): string {
  assertRemoteValue("root", root);
  if (!root.startsWith("/") || !NAME.test(owner) || !NAME.test(repo))
    throw new RemoteFailure("參數不合法", "root／owner／repo");
  return `${root.replace(/\/+$/, "")}/${owner}__${repo}__${cardHash(cardId)}`;
}

/** clone 後寫在 `.git` 裡（不弄髒工作樹）；沒有它的目錄一律不是 bridge 的。 */
const MARKER_FILE = "hdb-card-review";
const markerContent = (hash: string) => `hdb-card-review-checkout:v1:${hash}`;

async function assertMarker(exec: RemoteExec, dir: string, hash: string): Promise<void> {
  assertRemoteValue("cardHash", hash);
  const { code, stdout } = await exec(["cat", "--", `${dir}/.git/${MARKER_FILE}`], SHORT_MS);
  if (code !== 0) throw new RemoteFailure("既有目錄沒有 bridge marker");
  if (stdout.trim() !== markerContent(hash)) throw new RemoteFailure("既有目錄 marker 不符");
}

/** 遠端 `timeout` 先結束 git（124／137）；本機計時多等寬限，先到或 ssh 255 時遠端狀態不明。 */
export function sshRemoteExec(machine: MachineConfig, sshCommand = "ssh", graceMs = LOCAL_GRACE_MS): RemoteExec {
  return (argv, timeoutMs) =>
    new Promise((resolve, reject) => {
      if (!argv.length || argv.some((a) => !a || /[\u0000-\u001F\u007F]/.test(a)))
        return reject(new RemoteFailure("參數不合法", "argv"));
      const seconds = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
      const command = ["timeout", "-k", "10", seconds, ...argv].map(shellQuote).join(" ");
      const child = spawn(sshCommand, [...SSH_OPTIONS, machine.ssh, command], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new RemoteFailure("逾時", "local timer", true));
      }, timeoutMs + graceMs);
      child.stdout?.on("data", (c: Buffer) => (stdout = (stdout + c).slice(-65536)));
      child.stderr?.on("data", (c: Buffer) => (stderr = (stderr + c).slice(-300)));
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new RemoteFailure("連線失敗", error.message, true));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 255 || code === null) reject(new RemoteFailure("連線失敗", stderr.trim(), true));
        else if (code === 124 || code === 137) reject(new RemoteFailure("逾時", `exit ${code}`));
        else resolve({ code, stdout });
      });
    });
}

async function must(exec: RemoteExec, argv: string[], label: string, ms = SHORT_MS): Promise<string> {
  const result = await exec(argv, ms);
  if (result.code !== 0) throw new RemoteFailure(label, `exit ${result.code}`);
  return result.stdout;
}

const DIRTY = "既有目錄工作樹不乾淨";

/** 遠端 canonical path；失敗或不是單行絕對路徑就拒絕（同 sshRealpath）。 */
async function canonical(exec: RemoteExec, target: string): Promise<string> {
  const { code, stdout } = await exec(["realpath", "--", target], SHORT_MS);
  const real = stdout.replace(/\n$/, "");
  if (code !== 0 || !real.startsWith("/") || /[\u0000-\u001F\u007F]/.test(real)) throw new RemoteFailure("路徑驗證失敗", `realpath exit ${code}`);
  return real;
}

/** root 與 dir 須是 canonical path（符號連結拒絕）、dir 是 root 的直接子目錄；回傳 dir 是否已存在。 */
async function verifyCheckoutPath(exec: RemoteExec, root: string, dir: string): Promise<boolean> {
  assertRemoteValue("root", root);
  assertRemoteValue("dir", dir);
  const base = root.replace(/\/+$/, "");
  if (!base.startsWith("/") || !dir.startsWith(`${base}/`) || !NAME.test(dir.slice(base.length + 1)))
    throw new RemoteFailure("拒絕清理 root 以外的目錄");
  if ((await canonical(exec, base)) !== base) throw new RemoteFailure("root 是符號連結或在符號連結之下");
  const test = async (flag: string, path: string) => {
    const { code } = await exec(["test", flag, path], SHORT_MS);
    if (code > 1) throw new RemoteFailure("目錄檢查失敗", `exit ${code}`);
    return code === 0;
  };
  if (await test("-L", dir)) throw new RemoteFailure("既有目錄是符號連結");
  if (!(await test("-e", dir))) return false;
  if ((await canonical(exec, dir)) !== dir) throw new RemoteFailure("既有目錄是符號連結");
  if (await test("-L", `${dir}/.git`)) throw new RemoteFailure("既有目錄是符號連結");
  return true;
}

/** 先確認遠端有 GNU timeout。不存在才 clone 並寫 marker；既有目錄要 marker 相符、origin 相同、工作樹乾淨才沿用，否則拒絕且不碰（不 reset／clean）。 */
export async function prepareRemoteCheckout(
  exec: RemoteExec,
  input: { root: string; dir: string; owner: string; repo: string; prNumber: number; headSha: string; cardHash: string },
  onOwned: () => void,
): Promise<void> {
  const { dir, prNumber } = input;
  assertRemoteValue("dir", dir);
  if (!Number.isInteger(prNumber) || prNumber < 1 || !SHA.test(input.headSha))
    throw new RemoteFailure("參數不合法", "PR number／head sha");
  const url = assertRemoteValue("url", `https://github.com/${input.owner}/${input.repo}.git`);
  assertRemoteValue("cardHash", input.cardHash);
  // `true` 不會失敗：127 或 busybox 的 usage error（1）都是缺 GNU timeout。
  const probe = await exec(["timeout", "-k", "1", "5", "true"], SHORT_MS);
  if (probe.code !== 0) throw new RemoteFailure("遠端缺少 timeout", `exit ${probe.code}`);
  const ref = `refs/remotes/hdb/pr-${prNumber}`;
  if (await verifyCheckoutPath(exec, input.root, dir)) {
    if ((await exec(["test", "-e", `${dir}/.git`], SHORT_MS)).code !== 0) throw new RemoteFailure("既有目錄不是 repo");
    await assertMarker(exec, dir, input.cardHash);
    const origin = await must(exec, [...GIT, "-C", dir, "remote", "get-url", "origin"], "讀取 origin 失敗");
    if (origin.trim() !== url) throw new RemoteFailure("既有目錄 origin 不符");
    if ((await must(exec, [...GIT, "-C", dir, "status", "--porcelain", "--untracked-files=all"], "git status 失敗")).trim()) {
      onOwned();
      throw new RemoteFailure(DIRTY, DIRTY, true);
    }
    onOwned();
  }
  else {
    onOwned();
    await must(exec, [...GIT, "clone", "--no-checkout", "--no-tags", "--no-recurse-submodules", "--quiet", "--", url, dir], "clone 失敗", LONG_MS);
    await must(exec, ["sh", "-c", 'printf %s "$1" > "$2"', "sh", markerContent(input.cardHash), `${dir}/.git/${MARKER_FILE}`], "marker 寫入失敗");
  }
  await must(exec, [...GIT, "-C", dir, "fetch", "--no-tags", "--no-recurse-submodules", "--quiet", "--force", "origin", `refs/pull/${prNumber}/head:${ref}`], "fetch 失敗", LONG_MS);
  await must(exec, [...GIT, "-C", dir, "checkout", "--quiet", "--detach", ref], "checkout 失敗");
  const head = await must(exec, [...GIT, "-C", dir, "rev-parse", "HEAD"], "讀取 HEAD 失敗");
  if (head.trim() !== input.headSha) throw new RemoteFailure("HEAD 與 PR head 不符");
}

export async function remoteFingerprint(exec: RemoteExec, dir: string): Promise<string> {
  assertRemoteValue("dir", dir);
  const head = (await must(exec, [...GIT, "-C", dir, "rev-parse", "HEAD"], "讀取 HEAD 失敗")).trim();
  if (!SHA.test(head)) throw new RemoteFailure("讀取 HEAD 失敗");
  return `${head}\n${await must(exec, [...GIT, "-C", dir, "status", "--porcelain"], "git status 失敗")}`;
}

/**
 * 驗證與刪除在同一個遠端指令內（固定腳本，值只經位置參數 $1 root、$2 dir、$3 目錄名、$4 marker 傳入）：
 * 重取 root 的 realpath 並 cd 進去、dir 非符號連結且 realpath 等於 dir、marker 相符，才刪直接子目錄 `$3`。
 * 退出碼：0 已刪或不存在、11 root 非 canonical、12 dir 是符號連結、13 無 marker、14 marker 不符。
 */
export const REMOVE_SCRIPT =
  'r=$(realpath -- "$1") && [ "$r" = "$1" ] && cd -P -- "$r" || exit 11; [ -L "$3" ] && exit 12; [ -e "$3" ] || exit 0; ' +
  `d=$(realpath -- "$3") && [ "$d" = "$2" ] || exit 12; m=$(cat -- "$3/.git/${MARKER_FILE}") || exit 13; [ "$m" = "$4" ] || exit 14; rm -rf -- "$3"`;
const REMOVE_REFUSED: Record<number, string> = { 11: "root 是符號連結或在符號連結之下", 12: "既有目錄是符號連結", 13: "既有目錄沒有 bridge marker", 14: "既有目錄 marker 不符" };

/** 只刪 root 的直接子目錄；剩餘視窗縮到單一指令內，無法完全消除（已知限制）。 */
export async function removeRemoteCheckout(exec: RemoteExec, root: string, dir: string, hash: string): Promise<void> {
  assertRemoteValue("root", root);
  assertRemoteValue("dir", dir);
  assertRemoteValue("cardHash", hash);
  const base = root.replace(/\/+$/, "");
  const name = dir.slice(base.length + 1);
  if (!base.startsWith("/") || !dir.startsWith(`${base}/`) || !NAME.test(name)) throw new RemoteFailure("拒絕清理 root 以外的目錄");
  const { code } = await exec(["sh", "-c", REMOVE_SCRIPT, "sh", base, dir, name, markerContent(hash)], SHORT_MS);
  if (code !== 0) throw new RemoteFailure(REMOVE_REFUSED[code] ?? "清理失敗", `exit ${code}`);
}

/** 任何失敗都不改在本機開 pane 或啟動 Agent。 */
export interface RemoteReviewDeps {
  machine(id: string): MachineConfig | undefined;
  exec(machine: MachineConfig): RemoteExec;
  originUrl(worktreePath: string): Promise<string>;
  createWorkspace(machine: string, cwd: string, label: string): Promise<{ workspaceId: string; paneId: string }>;
  closeWorkspace(machine: string, workspaceId: string): Promise<void>;
  closeWorkspaceLabeled(machine: string, label: string): Promise<number>;
  sleep?(ms: number): Promise<void>;
  panePort(machine: string): AgentStartPort;
  startAgent: ReviewFlowDeps["startAgent"];
}

export async function reviewOnRemote(
  remote: RemoteReviewDeps,
  flow: ReviewFlowDeps,
  machineId: string,
  input: ReviewFlowInput & { prRepo: string; localWorktree: string },
): Promise<ReviewFlowResult> {
  const failed = (label: string, detail: unknown = label, note = ""): Error => {
    console.error(`remote review ${machineId}: ${label}: ${(detail as Partial<RemoteFailure>)?.detail ?? String(detail)}`);
    return new Error(`遠端 review 失敗：${label}${note ? `（${note}）` : ""}`);
  };
  const machine = remote.machine(machineId);
  const root = machine?.cardReview?.root;
  if (!machine || !root) throw failed("machine 未開放卡片 review");
  const origin = githubOriginRepo((await remote.originUrl(input.localWorktree)).trim());
  if (!origin || `${origin.owner}/${origin.repo}`.toLowerCase() !== input.prRepo.toLowerCase())
    throw new Error("origin 不是與 PR 相同的 GitHub repo，不在遠端 clone");
  const exec = remote.exec(machine);
  const dir = remoteCheckoutDir(root, origin.owner, origin.repo, input.card.id);
  const hash = cardHash(input.card.id);
  // 每次執行唯一，才不會關到前一次保留給人處理信任提示的 workspace。
  const label = `review-${hash}-${randomBytes(4).toString("hex")}`;
  let owned = false;
  // cleanup_pending 的定位資訊（workspace id／label、完整目錄）只進 console，紀錄與通知維持固定標籤。
  // create 逾時時遠端可能稍後才建好：有界重查，耗盡仍找不到就記 pending。
  const closeByLabel = async (): Promise<void> => {
    let last: unknown;
    for (let i = 0; i < LABEL_ATTEMPTS; i++) {
      if (i) await (remote.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(LABEL_RECHECK_MS);
      try {
        last = undefined;
        if ((await remote.closeWorkspaceLabeled(machineId, label)) > 0) return;
      } catch (e) {
        last = e;
      }
    }
    // 耗盡仍找不到：create 可能稍後才完成，狀態不明，記 cleanup_pending：workspace。
    throw last ?? new Error(`workspace label ${label} 重查 ${LABEL_ATTEMPTS} 次都沒有找到，狀態不明，請人工確認 ${machineId} 上有沒有它`);
  };
  const cleanup = async (workspace?: string, uncertain = false): Promise<string> => {
    const pending: string[] = [];
    const close = workspace === label ? closeByLabel() : workspace && remote.closeWorkspace(machineId, workspace);
    await (close || undefined)?.catch((e) => {
      pending.push("workspace");
      console.error(`remote review ${machineId}: cleanup_pending workspace ${workspace} label ${label}: ${String(e)}`);
    });
    if (owned && uncertain) {
      pending.push("directory");
      console.error(`remote review ${machineId}: cleanup_pending directory ${dir}: 未刪除（遠端狀態不明或工作樹不乾淨）`);
    } else if (owned)
      await removeRemoteCheckout(exec, root, dir, hash).catch((e) => {
        pending.push("directory");
        console.error(`remote review ${machineId}: cleanup_pending directory ${dir}: ${(e as Partial<RemoteFailure>)?.detail ?? String(e)}`);
      });
    return pending.length ? `cleanup_pending：${pending.join("、")}` : "";
  };
  const fail = async (error: unknown, fallback: string, workspace?: string, flowUncertain = false): Promise<never> => {
    const uncertain = flowUncertain || (error instanceof RemoteFailure && error.uncertain);
    throw failed(error instanceof RemoteFailure ? error.label : fallback, error, await cleanup(workspace, uncertain));
  };
  try {
    await prepareRemoteCheckout(exec, { root, dir, ...origin, prNumber: input.pr.number, headSha: input.pr.headSha, cardHash: hash }, () => (owned = true));
  } catch (error) {
    return fail(error, "checkout 失敗");
  }
  let ws: { workspaceId: string; paneId: string };
  try {
    ws = await remote.createWorkspace(machineId, dir, label);
    if (![ws.workspaceId, ws.paneId].every((id) => id.startsWith(`${machineId}:`))) throw new Error("unprefixed workspace id");
  } catch (error) {
    // 遠端可能已建好：依唯一 label 關閉。
    return fail(error, "workspace 失敗", label);
  }
  let result: ReviewFlowResult;
  // flow 會把指紋階段的 uncertain 失敗轉成字串：在這裡記住，清理才不會刪遠端可能還在用的目錄。
  let flowUncertain = false;
  const fingerprint = async (cwd: string): Promise<string> => {
    try {
      return await remoteFingerprint(exec, cwd);
    } catch (error) {
      if (error instanceof RemoteFailure && error.uncertain) flowUncertain = true;
      throw error;
    }
  };
  try {
    result = await runCardReview(
      { ...flow, panePort: remote.panePort(machineId), startAgent: remote.startAgent, fingerprint },
      { ...input, author: { ...input.author, paneId: ws.paneId, workspaceId: ws.workspaceId }, worktreePath: dir },
    );
  } catch (error) {
    return fail(error, /身分已改變/.test(String(error)) ? "身分不符" : "review 中斷", ws.workspaceId, flowUncertain);
  }
  const note = result.ok && result.paneKept ? "" : await cleanup(ws.workspaceId, flowUncertain);
  const fields = result as unknown as Record<string, unknown>;
  for (const key of ["error", "closeNote", "inconclusiveReason"]) {
    const text = fields[key];
    const scrubbed = typeof text === "string" ? fixedResultText(text) : text;
    if (scrubbed !== text) console.error(`remote review ${machineId}: ${key}: ${String(text)}`);
    fields[key] = scrubbed;
  }
  if (note) fields.closeNote = fields.closeNote ? `${String(fields.closeNote)}；${note}` : note;
  return result;
}

/** startAgent 由 pane id 前綴取 machine，不做本機信任預處理、不帶 cwd。 */
export function remoteReviewDeps(hub: Pick<HerdrHub, "request" | "requestOn" | "freshAgentsOn" | "machineConfig">): RemoteReviewDeps {
  const panePort = (machine: string) => ({ request: hub.request.bind(hub), listAgentsWithWorkspaceNames: () => hub.freshAgentsOn(machine) });
  return {
    machine: (id) => hub.machineConfig(id),
    exec: (machine) => sshRemoteExec(machine),
    originUrl: async (cwd) => (await defaultExec("git", ["remote", "get-url", "origin"], { cwd })).stdout,
    createWorkspace: async (machine, cwd, label) => {
      const created = (await hub.requestOn(machine, "workspace.create", { cwd, label, focus: false })) as { workspace?: { workspace_id?: unknown }; root_pane?: { pane_id?: unknown } };
      const [workspaceId, paneId] = [created.workspace?.workspace_id, created.root_pane?.pane_id];
      if (typeof workspaceId !== "string" || typeof paneId !== "string") throw new Error("workspace.create 的回應缺少 workspace 或 pane id");
      return { workspaceId, paneId };
    },
    closeWorkspace: async (machine, workspace_id) => void (await hub.requestOn(machine, "workspace.close", { workspace_id })),
    closeWorkspaceLabeled: async (machine, label) => {
      let closed = 0;
      const { workspaces } = (await hub.requestOn(machine, "workspace.list")) as { workspaces?: { workspace_id?: unknown; label?: unknown }[] };
      if (!Array.isArray(workspaces)) throw new Error("workspace.list 沒有 workspaces");
      for (const w of workspaces)
        if (typeof w.workspace_id === "string" && [label, `${machine}:${label}`].includes(String(w.label))) {
          await hub.requestOn(machine, "workspace.close", { workspace_id: w.workspace_id });
          closed++;
        }
      return closed;
    },
    panePort,
    startAgent: ({ paneId, kind, name, args }) =>
      startAgentInPane(panePort(paneId.split(":")[0]!), { paneId, kind, name, ...(args ? { args } : {}), skipWorkspaceTrust: true }),
  };
}
