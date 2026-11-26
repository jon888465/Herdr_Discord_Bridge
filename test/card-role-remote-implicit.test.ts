import test from "node:test";
import { deepEqual as eq, equal, throws } from "node:assert/strict";
import { validateProfiles } from "../src/agent-pool.js";
import {
  parseRemoteTarget,
  preflightRoles,
  remoteReviewerCandidates,
  remoteRoleCandidates,
  remoteRoleTargets,
  validateRoleSnapshot,
  type RoleContext,
} from "../src/card-role-assignment.js";

/**
 * ISSUE-211：本機沒有 pi profile（使用者刻意關掉），但遠端機器的 `cardReview.kinds` 開放了 pi。
 * 角色驗證原本對遠端角色也要求本機有同 kind 的 profile，所以 `implement: <machine>:pi` 在撿卡時被拒絕。
 * 現在：本機完全沒有同 kind 的 profile 時，才為遠端機器開放的 kind 補一個只用在遠端的隱含 profile；
 * 本機有同 kind 的 profile 時完全照舊（它的能力設定仍是閘門）；機器自己的 kinds／write／toolchain 閘門都保留。
 */
const helper = validateProfiles([{ id: "helper", kind: "codex" }]);
const open = [{ id: "pod", kinds: ["pi", "codex"], write: true, toolchain: true }];
const context: RoleContext = { machineIds: ["pod"], profiles: helper, remoteMachines: open };

test("a remote pi role is accepted with no local pi profile and the frozen snapshot re-validates", () => {
  const snapshot = preflightRoles({ implement: { machine: "pod", agent: "pi" }, reviewer: { machine: "pod", agent: "pi" } }, context);
  eq(snapshot.candidates.implement?.map((p) => [p.id, p.kind, p.model, p.args]), [["pi", "pi", undefined, []]]);
  eq(snapshot.candidates.reviewer?.map((p) => p.id), ["pi"]);
  eq(snapshot.remoteMachines, open);
  validateRoleSnapshot(structuredClone(snapshot));
});

test("the machine's own gates still apply: kinds, write and toolchain", () => {
  throws(() => preflightRoles({ implement: { machine: "pod", agent: "agy" } }, context), /machine 未開放卡片 review/);
  throws(
    () => preflightRoles({ implement: { machine: "pod", agent: "pi" } }, { ...context, remoteMachines: [{ id: "pod", kinds: ["pi"] }] }),
    /remote implement 不可用.*cardReview\.write/,
  );
  throws(
    () => preflightRoles({ verify: { machine: "pod", agent: "pi" } }, { ...context, remoteMachines: [{ id: "pod", kinds: ["pi"], write: true }] }),
    /remote verify 不可用/,
  );
});

test("the implicit profile is remote only: a local pi role is still rejected", () => {
  throws(() => preflightRoles({ implement: { machine: "local", agent: "pi" } }, context), /agent pi 未開放/);
  throws(() => preflightRoles({ implement: { agent: "pi" } }, context), /agent pi 未開放/);
});

test("a model can only be pinned through a local profile allowlist, never on the implicit profile", () => {
  throws(() => preflightRoles({ implement: { machine: "pod", agent: "pi", model: "some-model" } }, context), /不合法 model some-model/);
});

test("a local profile of the same kind stays authoritative: its capabilities remain the gate", () => {
  const analysisOnly = validateProfiles([{ id: "pi", kind: "pi", capabilities: ["analysis"] }]);
  throws(
    () => preflightRoles({ implement: { machine: "pod", agent: "pi" } }, { ...context, profiles: [...helper, ...analysisOnly] }),
    /agent pi 未開放/,
  );
  const enabled = validateProfiles([{ id: "my-pi", kind: "pi", capabilities: ["implementation"] }]);
  const snapshot = preflightRoles({ implement: { machine: "pod", agent: "pi" } }, { ...context, profiles: [...helper, ...enabled] });
  eq(snapshot.candidates.implement?.map((p) => p.id), ["my-pi"], "用本機 profile，不另外補隱含的");
});

test("a workspace's selected profile list does not hide the implicit remote profile", () => {
  const snapshot = preflightRoles({ implement: { machine: "pod", agent: "pi" } }, { ...context, enabledProfileIds: ["helper"] });
  eq(snapshot.candidates.implement?.map((p) => p.id), ["pi"]);
});

test("Lead candidates and targets include the implicit remote profile with the machine's gates", () => {
  const candidates = remoteRoleCandidates(context).filter((c) => c.kind === "pi");
  eq(
    candidates.map((c) => [c.role, c.profileId, c.available]).sort(),
    [["diagnose", "pi", true], ["implement", "pi", true], ["review", "pi", true], ["verify", "pi", true]],
  );
  eq(
    remoteRoleCandidates({ ...context, remoteMachines: [{ id: "pod", kinds: ["pi"] }] })
      .filter((c) => c.role === "implement")
      .map((c) => [c.available, c.reason]),
    [[false, "machine does not allow writes"]],
  );
  const targets = remoteRoleTargets(context, "w1").filter((t) => t.agent === "pi");
  const implement = targets.find((t) => t.pane_id === "remote:pod:implement:pi");
  equal(implement?.machine, "pod");
  eq((implement?.profile as { id: string; kind: string; args: string[] }).args, []);
  eq(parseRemoteTarget("remote:pod:implement:pi"), { machine: "pod", role: "implement", profileId: "pi" });
  eq(remoteReviewerCandidates(context).filter((c) => c.kind === "pi").map((c) => c.profileId), ["pi"]);
});

test("with a local profile of the kind there is exactly one candidate and no implicit duplicate", () => {
  const local = validateProfiles([{ id: "my-pi", kind: "pi", capabilities: ["implementation", "review"] }]);
  const ctx = { ...context, profiles: [...helper, ...local] };
  eq(remoteRoleCandidates(ctx).filter((c) => c.kind === "pi" && c.role === "implement").map((c) => c.profileId), ["my-pi"]);
  eq(remoteReviewerCandidates(ctx).filter((c) => c.kind === "pi").map((c) => c.profileId), ["my-pi"]);
});

test("a disconnected machine offers neither candidates nor acceptance", () => {
  const down = { ...context, isDisconnected: (id: string) => id === "pod" };
  eq(remoteRoleCandidates(down), []);
  throws(() => preflightRoles({ implement: { machine: "pod", agent: "pi" } }, down), /machine 已斷線（pod），不會 fallback 到本機/);
});
