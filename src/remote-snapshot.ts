// task 內 remote 唯讀角色：工作副本快照 bundle 經 ssh stdin 送到 pod；不推送到 origin、不動分支與 index。細節只進 console。

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentProfile } from "./agent-pool.js";
import { doneAsReady, waitUntilReady } from "./agent-ready.js";
import { assertFreshProfile } from "./card-role-assignment.js";
import { assertReadyIdentity, type RoleCleanupReason } from "./card-role-session.js";
import { captureCodingTree, digest } from "./coding-version.js";
import { editRemoteAgyTrust } from "./remote-agy-trust.js";
import { GIT, LONG_MS, MARKER_FILE, RemoteFailure, SHA, SHORT_MS, assertRemoteValue, cardHash, githubOriginRepo, markerContent, must } from "./remote-checkout.js";
import { remoteCheckoutDir, remoteFingerprint, removeRemoteCheckout, verifyCheckoutPath, type RemoteExec, type RemoteReviewDeps } from "./remote-checkout.js";
import type { AgentRecord } from "./types.js";

export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
const REF = /^refs\/hdb-snapshot\/[0-9a-f]{16}$/;
/** 固定身分與時間：同樣的內容與 HEAD 得到同一個快照 sha。 */
const IDENTITY = Object.fromEntries(["AUTHOR", "COMMITTER"].flatMap((w) => [[`GIT_${w}_NAME`, "hdb-snapshot"], [`GIT_${w}_EMAIL`, "hdb-snapshot@invalid"], [`GIT_${w}_DATE`, "@0 +0000"]]));

export type LocalGit = (args: string[], env?: Record<string, string>) => string;
export const localGit = (cwd: string): LocalGit => (args, extra = {}) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_OPTIONAL_LOCKS: "0", ...extra },
  });

export const treeDigest = (cwd: string): string => digest(JSON.stringify(captureCodingTree(cwd)));

export type LocalSnapshot = { sha: string; tree: string; ref: string; bundle: string; bytes: number; digest: string; dispose(): void };

/** 暫時 index 做快照 commit（含未追蹤）；前後指紋不同作廢；bundle 只含 origin 沒有的物件，超過上限不送。 */
export function createLocalSnapshot(cwd: string, git: LocalGit = localGit(cwd), maxBytes = MAX_BUNDLE_BYTES, digestOf = treeDigest): LocalSnapshot {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hdb-snapshot-"));
  const ref = `refs/hdb-snapshot/${randomBytes(8).toString("hex")}`;
  let refMade = false;
  const dropRef = () => {
    if (refMade) {
      try {
        git(["update-ref", "-d", ref]);
        refMade = false;
      } catch (error) {
        console.error(`remote snapshot: 暫時 ref 刪除失敗 ${ref}: ${String(error)}`);
      }
    }
  };
  const dispose = () => (dropRef(), fs.rmSync(tmp, { recursive: true, force: true }));
  try {
    const before = digestOf(cwd);
    const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
    git(["read-tree", "HEAD"], env);
    git(["add", "-A"], env);
    const tree = git(["write-tree"], env).trim();
    const sha = git(["commit-tree", "--no-gpg-sign", tree, "-p", "HEAD", "-m", "hdb snapshot"], IDENTITY).trim();
    if (!SHA.test(tree) || !SHA.test(sha)) throw new RemoteFailure("快照建立失敗", "sha");
    if (digestOf(cwd) !== before) throw new RemoteFailure("快照已作廢", "建立快照時本機工作樹改變");
    git(["update-ref", ref, sha]);
    refMade = true;
    const bundle = path.join(tmp, "snapshot.bundle");
    git(["bundle", "create", bundle, ref, "--not", "--remotes=origin"]);
    dropRef();
    const bytes = fs.statSync(bundle).size;
    if (bytes > maxBytes) throw new RemoteFailure("快照 bundle 超過大小上限", `${bytes} bytes`);
    return { sha, tree, ref, bundle, bytes, digest: before, dispose };
  } catch (error) {
    dispose();
    throw error instanceof RemoteFailure ? error : new RemoteFailure("快照建立失敗", String(error));
  }
}

/** 建目錄與 marker 同一指令，之後失敗都有 marker 可清。 */
const MKDIR_SCRIPT = `mkdir -- "$1" || exit 1; { mkdir -- "$1/.git" && printf %s "$2" > "$1/.git/${MARKER_FILE}"; } || { rm -rf -- "$1"; exit 1; }`;

/** pod：目錄須不存在；HEAD 與 tree 須等於快照；取消在步驟之間中止。 */
export async function prepareRemoteSnapshot(
  exec: RemoteExec,
  input: { root: string; dir: string; owner: string; repo: string; cardHash: string; snapshot: Pick<LocalSnapshot, "sha" | "tree" | "ref" | "bundle"> },
  onOwned: () => void,
  maxBytes = MAX_BUNDLE_BYTES,
  signal?: AbortSignal,
): Promise<void> {
  const { dir, snapshot: snap } = input;
  assertRemoteValue("dir", dir);
  assertRemoteValue("cardHash", input.cardHash);
  if (!SHA.test(snap.sha) || !SHA.test(snap.tree) || !REF.test(snap.ref)) throw new RemoteFailure("參數不合法", "snapshot sha／ref");
  const url = assertRemoteValue("url", `https://github.com/${input.owner}/${input.repo}.git`);
  const file = `${dir}/.git/hdb-snapshot.bundle`;
  const probe = await exec(["timeout", "-k", "1", "5", "true"], SHORT_MS);
  if (probe.code !== 0) throw new RemoteFailure("遠端缺少 timeout", `exit ${probe.code}`);
  if (await verifyCheckoutPath(exec, input.root, dir)) throw new RemoteFailure("快照目錄已存在");
  await must(exec, ["sh", "-c", MKDIR_SCRIPT, "sh", dir, markerContent(input.cardHash)], "marker 寫入失敗");
  onOwned();
  const step = async (argv: string[], label: string, ms = SHORT_MS) => (signal?.throwIfAborted(), must(exec, argv, label, ms));
  await step([...GIT, "init", "--quiet", "--", dir], "clone 失敗");
  await step([...GIT, "-C", dir, "remote", "add", "origin", url], "clone 失敗");
  await step([...GIT, "-C", dir, "fetch", "--no-tags", "--no-recurse-submodules", "--quiet", "origin"], "clone 失敗", LONG_MS);
  signal?.throwIfAborted();
  if ((await exec(["sh", "-c", 'head -c "$2" > "$1"', "sh", file, String(maxBytes + 1)], LONG_MS, snap.bundle)).code !== 0) throw new RemoteFailure("bundle 傳送失敗");
  await step([...GIT, "-C", dir, "bundle", "verify", "--quiet", file], "bundle 驗證失敗");
  // 讀 bundle 走 file transport，只在這一步開放。
  await step([...GIT, "-c", "protocol.file.allow=always", "-C", dir, "fetch", "--no-tags", "--quiet", file, `${snap.ref}:refs/hdb/snapshot`], "fetch 失敗", LONG_MS);
  await step([...GIT, "-C", dir, "checkout", "--quiet", "--detach", "refs/hdb/snapshot"], "checkout 失敗");
  const [head, tree] = (await must(exec, [...GIT, "-C", dir, "rev-parse", "HEAD", "HEAD^{tree}"], "讀取 HEAD 失敗")).trim().split("\n");
  if (head !== snap.sha || tree !== snap.tree) throw new RemoteFailure("HEAD 與快照 sha 不符");
  await must(exec, ["rm", "-f", "--", file], "bundle 刪除失敗");
}

export type RemoteRoleDeps = Pick<RemoteReviewDeps, "machine" | "exec" | "originUrl" | "createWorkspace" | "closeWorkspace" | "closeWorkspaceLabeled" | "panePort" | "startAgent" | "sleep"> & {
  snapshot?(cwd: string): LocalSnapshot;
  treeDigest?(cwd: string): string;
};

/** 失敗不 fallback 本機。cleanup：blocked／timeout／uncertain 保留（與 card-role-session 對同一 RoleCleanupReason 一致）；workspace 沒關成不刪目錄，記 cleanup_pending。 */
export async function startRemoteRole(
  deps: RemoteRoleDeps,
  input: { machineId: string; role: string; key: string; cwd: string; profile: AgentProfile; name: string; signal?: AbortSignal },
): Promise<{ agent: AgentRecord; continuity: "new-session"; cleanup(reason?: RoleCleanupReason): Promise<void>; afterTurn(): Promise<void> }> {
  const { machineId: id, profile } = input;
  const fail = (label: string, detail: unknown = label): Error => {
    console.error(`remote role ${id}: ${label}: ${(detail as Partial<RemoteFailure>)?.detail ?? String(detail)}`);
    return new Error(`遠端角色失敗：${label}`);
  };
  try {
    assertFreshProfile(profile);
  } catch (error) {
    throw fail("profile 不可續接既有 session", error);
  }
  const machine = deps.machine(id);
  const open = machine?.cardReview;
  if (!machine || !open?.kinds.includes(profile.kind)) throw fail("machine 未開放這個 agent 種類");
  if (input.role === "verify" && !open.toolchain) throw fail("verify 不可用（machine 沒有工具鏈）");
  const origin = githubOriginRepo((await deps.originUrl(input.cwd)).trim());
  if (!origin) throw fail("origin 不是 GitHub repo，不在遠端 clone");
  const exec = deps.exec(machine);
  const { root } = open;
  // task 內快照與 PR 階段 remote reviewer 用不同的目錄名與 marker（key 加前綴），任一邊留下的目錄不會擋住或被另一邊接管。
  const scoped = `task-snapshot:${input.key}`;
  const dir = remoteCheckoutDir(root, origin.owner, origin.repo, scoped);
  const hash = cardHash(scoped);
  const label = `task-${hash}-${randomBytes(4).toString("hex")}`;
  const st = { owned: false, uncertain: false, attempted: false, workspace: "", trust: false, trustUnknown: false };
  const trust = { root, dir, cardHash: hash };
  let cleaned: Promise<string> | undefined;
  const cleanup = (reason: RoleCleanupReason = "completed") =>
    (cleaned ??= (async () => {
      if (reason === "blocked" || reason === "timeout" || reason === "uncertain") {
        console.error(`remote role ${id}: cleanup_pending workspace ${st.workspace} directory ${dir}: ${reason}，保留給人處理`);
        return `（cleanup_pending：workspace、${st.trust || st.trustUnknown ? "trust、" : ""}directory）`;
      }
      const pending: string[] = [];
      let closed = true;
      const byLabel = async () => {
        for (let i = 0; i < 3; i++) {
          if (i) await (deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(2000);
          if ((await deps.closeWorkspaceLabeled(id, label)) > 0) return;
        }
        throw new Error("label not found");
      };
      const close = st.workspace ? deps.closeWorkspace(id, st.workspace) : st.attempted ? byLabel() : undefined;
      await close?.catch(() => (closed = false));
      if (!closed) pending.push("workspace");
      if (st.trust || st.trustUnknown) await editRemoteAgyTrust(exec, trust, false).catch(() => void pending.push("trust"));
      if (st.trustUnknown && !pending.includes("trust")) pending.push("trust");
      if (st.owned && (st.uncertain || !closed)) pending.push("directory");
      else if (st.owned) await removeRemoteCheckout(exec, root, dir, hash).catch(() => void pending.push("directory"));
      if (pending.length) console.error(`remote role ${id}: cleanup_pending ${pending.join(",")} label ${label} directory ${dir}（${reason}）`);
      return pending.length ? `（cleanup_pending：${pending.join("、")}）` : "";
    })());
  let digestAtSnapshot: string;
  let before: string;
  let agent: AgentRecord;
  try {
    const snap = (deps.snapshot ?? createLocalSnapshot)(input.cwd);
    digestAtSnapshot = snap.digest;
    try {
      await prepareRemoteSnapshot(exec, { root, dir, ...origin, cardHash: hash, snapshot: snap }, () => (st.owned = true), undefined, input.signal);
    } finally {
      snap.dispose();
    }
    input.signal?.throwIfAborted();
    st.attempted = true;
    const ws = await deps.createWorkspace(id, dir, label);
    if (![ws.workspaceId, ws.paneId].every((v) => v.startsWith(`${id}:`))) throw new RemoteFailure("workspace 失敗", "unprefixed id");
    st.workspace = ws.workspaceId;
    if (profile.kind === "agy")
      try {
        st.trust = await editRemoteAgyTrust(exec, trust, true);
      } catch (error) {
        st.trustUnknown = error instanceof RemoteFailure && error.uncertain;
        throw error;
      }
    input.signal?.throwIfAborted();
    // 唯讀基準要在 Agent 啟動之前取（與 card-review-flow 一致），啟動期間寫進 pod 工作樹的檔案不會被算進基準。
    before = await remoteFingerprint(exec, dir);
    const args = [...(profile.args ?? []), ...(profile.model ? [profile.modelFlag!, profile.model] : [])];
    const started = await deps.startAgent({ paneId: ws.paneId, kind: profile.kind, name: input.name, ...(args.length ? { args } : {}) });
    const port = deps.panePort(id);
    const ready = await waitUntilReady({ panePort: doneAsReady(port), role: "Worker", expectedKind: profile.kind }, { paneId: started.pane_id, terminalId: started.terminal_id }, started.agent_status === "done" ? { ...started, agent_status: "idle" } : started);
    if (!ready.ok) throw new RemoteFailure("Worker 沒有就緒", ready.reason);
    const live = (await port.listAgentsWithWorkspaceNames()).find((a) => a.pane_id === started.pane_id);
    if (!live) throw new RemoteFailure("Worker 就緒後 pane 已不存在");
    assertReadyIdentity(started, live, profile.kind, ws.workspaceId, id);
    if (profile.model && live.model && live.model !== profile.model) throw new RemoteFailure("身分不符", "model");
    agent = { ...live, machine: id, profileId: profile.id, ...(profile.model ? { model: profile.model, modelEvidence: "launch" } : {}) };
  } catch (error) {
    if (error instanceof RemoteFailure && error.uncertain) st.uncertain = true;
    const reason = error instanceof RemoteFailure ? error.label : input.signal?.aborted ? "已取消" : /身分已改變/.test(String(error)) ? "身分不符" : "準備失敗";
    throw fail(`${reason}${await cleanup("before_dispatch_failure")}`, error);
  }
  const afterTurn = async () => {
    const after = await remoteFingerprint(exec, dir).catch((error: unknown) => {
      if (error instanceof RemoteFailure && error.uncertain) st.uncertain = true;
      throw fail("唯讀檢查失敗", error);
    });
    if (after !== before) throw fail("遠端工作樹在唯讀角色中被改動，結果不採用");
    let local: string;
    try {
      local = (deps.treeDigest ?? treeDigest)(input.cwd);
    } catch (error) {
      throw fail("唯讀檢查失敗", error instanceof Error ? error.message.split("\n")[0] : "本機讀取失敗");
    }
    if (local !== digestAtSnapshot) throw fail("快照已作廢（本機工作樹已改變），結果不採用");
  };
  return { agent, continuity: "new-session", cleanup: async (reason) => void (await cleanup(reason)), afterTurn };
}
