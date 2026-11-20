// 遠端 Herdr server 需要重啟時的換埠（ISSUE-177）：偵測成結構化結果；使用者確認後 add 走有核准的路徑。
import assert from "node:assert/strict";
import test from "node:test";
import {
  isRemoteRestartRequired,
  reconcileHerdrPort,
  reconcileHerdrPortOutcome,
} from "../src/herdr-machine-sync.js";

const machine = { id: "devbox", ssh: "devbox", port: 50123, socket: "/s" };
const OLD = { id: "old1", label: "devbox", target: "ssh://devbox:40000", enabled: true };
/** 2026-11-20 實機 bridge 日誌裡 Herdr 對非互動 `machine add` 的原話。 */
const NOT_READY =
  "remote herdr server on ssh://devbox:50123 (session default) is still running v0.9.5; it will use 0.9.5 after it restarts. error: remote server is not ready for saved machines; machine was not saved";

type HerdrError = Error & { herdrOutput?: string };
const herdrError = (output: string): HerdrError => Object.assign(new Error("Command failed"), { herdrOutput: output });

/** 一般 runner：add 一律被 Herdr 以「需要重啟」拒絕；approved runner：模擬使用者確認後的互動式 add。 */
function fake(options: { addError?: HerdrError; approvedError?: HerdrError } = {}) {
  const profiles = [{ ...OLD }];
  const calls: string[] = [];
  const approvedCalls: string[] = [];
  const apply = (args: string[]): void => {
    profiles.push({ id: "new1", label: args[args.indexOf("--label") + 1]!, target: args[2]!, enabled: true });
  };
  const run = async (args: string[], timeoutMs = 2000): Promise<string> => {
    const verb = args[1];
    calls.push(args.slice(1).join(" "));
    if (verb === "list") return JSON.stringify(profiles);
    if (verb === "add") {
      if (timeoutMs < 5000) throw new Error("timed out");
      if (options.addError) throw options.addError;
      apply(args);
      return "Saved";
    }
    if (verb === "status") return JSON.stringify(profiles.map((p) => ({ id: p.id, label: p.label, status: "reachable" })));
    if (verb === "remove") {
      profiles.splice(profiles.findIndex((p) => p.id === args[2]), 1);
      return "Removed";
    }
    if (verb === "rename") {
      profiles.find((p) => p.id === args[2])!.label = args[4]!;
      return "Renamed";
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  const runApproved = async (args: string[]): Promise<string> => {
    approvedCalls.push(args.slice(1).join(" "));
    if (options.approvedError) throw options.approvedError;
    apply(args);
    return "Saved SSH machine new1. Remote server is ready.";
  };
  return { run, runApproved, profiles, calls, approvedCalls };
}

const quiet = (): void => {};
const instant = async (): Promise<void> => {};

test("isRemoteRestartRequired 認得 Herdr 的兩種說法，不誤判其他失敗", () => {
  assert.equal(isRemoteRestartRequired(herdrError(NOT_READY)), true);
  assert.equal(isRemoteRestartRequired(herdrError("restart the remote server now? [y/N] error: remote setup cancelled")), true);
  assert.equal(isRemoteRestartRequired(new Error("ssh: connect to host 127.0.0.1 port 1: Connection refused")), false);
  assert.equal(isRemoteRestartRequired(new Error("timed out")), false);
  assert.equal(isRemoteRestartRequired("remote platform detection failed"), false);
});

test("add 被 Herdr 以需要重啟拒絕：結果帶 needsRemoteRestart，舊設定保留，說明文字與以往相同", async () => {
  const herdr = fake({ addError: herdrError(NOT_READY) });
  const outcome = await reconcileHerdrPortOutcome(machine, herdr.run, instant, quiet);
  assert.deepEqual(outcome, { note: "Herdr 側邊欄的埠沒有更新成功，保留原設定", needsRemoteRestart: true });
  assert.deepEqual(herdr.profiles, [OLD]);
  assert.deepEqual(herdr.approvedCalls, []);
});

test("既有的 reconcileHerdrPort 行為不變：只回說明", async () => {
  const herdr = fake({ addError: herdrError(NOT_READY) });
  assert.equal(await reconcileHerdrPort(machine, herdr.run, instant, quiet), "Herdr 側邊欄的埠沒有更新成功，保留原設定");
});

test("add 因為別的原因失敗（連不上、逾時）：不要求確認重啟", async () => {
  for (const error of [herdrError("ssh: connect to host 127.0.0.1 port 50123: Connection refused"), new Error("timed out")]) {
    const herdr = fake({ addError: error as HerdrError });
    const outcome = await reconcileHerdrPortOutcome(machine, herdr.run, instant, quiet);
    assert.equal(outcome.needsRemoteRestart, undefined);
    assert.deepEqual(herdr.profiles, [OLD]);
  }
});

test("沒有同別名不同埠的舊項目，或已經是新埠：什麼都不做，也不要求確認", async () => {
  const same = fake();
  same.profiles[0]!.target = "ssh://devbox:50123";
  assert.deepEqual(await reconcileHerdrPortOutcome(machine, same.run, instant, quiet), {});
  const none = fake();
  none.profiles.length = 0;
  assert.deepEqual(await reconcileHerdrPortOutcome(machine, none.run, instant, quiet), {});
});

test("使用者已確認：add 走有核准的路徑（一般 runner 不會收到 add），整個換埠成功", async () => {
  const herdr = fake({ addError: herdrError(NOT_READY) });
  const lines: string[] = [];
  const outcome = await reconcileHerdrPortOutcome(machine, herdr.run, instant, (m) => lines.push(m), {
    approveRestart: true,
    runApproved: herdr.runApproved,
  });
  assert.deepEqual(outcome, { note: "Herdr 側邊欄已更新到埠 50123" });
  assert.deepEqual(herdr.approvedCalls, ["add ssh://devbox:50123 --label devbox-new"]);
  assert.equal(herdr.calls.some((call) => call.startsWith("add ")), false);
  assert.deepEqual(herdr.profiles.map((p) => [p.label, p.target]), [["devbox", "ssh://devbox:50123"]]);
  assert.match(lines.join("\n"), /使用者已確認重啟遠端 server/);
});

test("已確認但互動式 add 失敗：不再要求確認（避免一直問），舊設定保留", async () => {
  const herdr = fake({ approvedError: herdrError(`${NOT_READY} restart the remote server now? [y/N]`) });
  const outcome = await reconcileHerdrPortOutcome(machine, herdr.run, instant, quiet, {
    approveRestart: true,
    runApproved: herdr.runApproved,
  });
  assert.deepEqual(outcome, { note: "Herdr 側邊欄的埠沒有更新成功，保留原設定" });
  assert.deepEqual(herdr.profiles, [OLD]);
});

test("沒有確認時，絕不走有核准的路徑", async () => {
  const herdr = fake();
  await reconcileHerdrPortOutcome(machine, herdr.run, instant, quiet, { runApproved: herdr.runApproved });
  assert.deepEqual(herdr.approvedCalls, []);
  assert.equal(herdr.calls.some((call) => call.startsWith("add ")), true);
});
