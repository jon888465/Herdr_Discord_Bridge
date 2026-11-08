import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPool, validateProfiles } from "../src/agent-pool.js";
import type { AgentRecord } from "../src/types.js";

const lead: AgentRecord = {
  pane_id: "w1:p1",
  workspace_id: "w1",
  terminal_id: "lead",
  tab_id: "w1:t1",
  agent: "codex",
  agent_status: "idle",
  cwd: "/repo",
};
const profile = { id: "helper", kind: "codex", model: "configured-model" };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-pool-"));
  const file = join(dir, "pool.json");
  let agents: AgentRecord[] = [lead];
  let starts = 0;
  const port = {
    listAgentsWithWorkspaceNames: async () => agents,
    startProfile: async (
      _lead: AgentRecord,
      _profile: unknown,
      _name: string,
      onPane: (id: string) => void,
    ) => {
      starts++;
      const a: AgentRecord = {
        ...lead,
        pane_id: `w1:p${starts + 1}`,
        terminal_id: `worker-${starts}`,
        agent_session: { kind: "id", value: `s${starts}` },
      };
      onPane(a.pane_id);
      agents.push(a);
      return a;
    },
  };
  const pool = new AgentPool(file, [profile], port, ["w1"]);
  return {
    pool,
    port,
    file,
    get starts() {
      return starts;
    },
    agents: () => agents,
    set: (a: AgentRecord[]) => {
      agents = a;
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("pool selection persists without starting a CLI; unselected/unauthorized acquire rejects", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.pool.acquire("w1", "helper", lead, "task"),
      /not enabled/,
    );
    assert.throws(() => f.pool.select("w2", "helper", true), /authorized/);
    f.pool.select("w1", "helper", true);
    assert.equal(f.starts, 0);
    assert.match(await f.pool.describe("w1"), /\[x\].*not started/);
    const reloaded = new AgentPool(f.file, [profile], f.port, ["w1"]);
    assert.deepEqual(reloaded.members("w1"), ["helper"]);
  } finally {
    f.close();
  }
});

test("acquire starts once, release preserves context, restart reuses the identified session", async () => {
  const f = fixture();
  try {
    f.pool.select("w1", "helper", true);
    const first = await f.pool.acquire("w1", "helper", lead, "a");
    assert.equal(first.continuity, "new-session");
    await assert.rejects(f.pool.acquire("w1", "helper", lead, "b"), /leased/);
    assert.throws(() => f.pool.selectAll("w1", []), /in use/);
    f.pool.release("a");
    const pool = new AgentPool(f.file, [profile], f.port, ["w1"]);
    const next = await pool.acquire("w1", "helper", lead, "b");
    assert.equal(next.continuity, "same-session");
    assert.equal(next.agent.pane_id, first.agent.pane_id);
    assert.equal(f.starts, 1);
  } finally {
    f.close();
  }
});

test("changed or busy session fails closed; missing metadata is never same-session", async () => {
  const f = fixture();
  try {
    f.pool.select("w1", "helper", true);
    const a = (await f.pool.acquire("w1", "helper", lead, "a")).agent;
    f.pool.release("a");
    f.set([lead, { ...a, agent_status: "blocked" }]);
    await assert.rejects(f.pool.acquire("w1", "helper", lead, "b"), /blocked/);
    f.set([
      lead,
      { ...a, agent_session: { kind: "id", value: "replacement" } },
    ]);
    await assert.rejects(
      f.pool.acquire("w1", "helper", lead, "b"),
      /identity changed/,
    );
    const unknown = { ...a, agent_session: undefined };
    f.set([lead, unknown]);
    f.pool.bind("w1", "helper", unknown);
    assert.equal(
      (await f.pool.acquire("w1", "helper", lead, "c")).continuity,
      "unknown",
    );
    assert.equal(f.starts, 1);
  } finally {
    f.close();
  }
});

test("uncertain startup survives restart and prevents duplicate creation", async () => {
  const f = fixture();
  try {
    f.pool.select("w1", "helper", true);
    let starts = 0;
    f.port.startProfile = async (_lead, _p, _name, onPane) => {
      starts++;
      onPane("w1:p9");
      throw new Error("socket closed after start");
    };
    await assert.rejects(
      f.pool.acquire("w1", "helper", lead, "a"),
      /socket closed/,
    );
    const pool = new AgentPool(f.file, [profile], f.port, ["w1"]);
    await assert.rejects(pool.acquire("w1", "helper", lead, "b"), /uncertain/);
    assert.equal(starts, 1);
    assert.match(await pool.describe("w1"), /uncertain/);
  } finally {
    f.close();
  }
});

test("parallel acquisition never starts duplicate panes", async () => {
  const f = fixture();
  try {
    f.pool.select("w1", "helper", true);
    const results = await Promise.allSettled([
      f.pool.acquire("w1", "helper", lead, "a"),
      f.pool.acquire("w1", "helper", lead, "b"),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(f.starts, 1);
  } finally {
    f.close();
  }
});

test("profile changes require explicit rebinding instead of silently reusing another model", async () => {
  const f = fixture();
  try {
    f.pool.select("w1", "helper", true);
    await f.pool.acquire("w1", "helper", lead, "a");
    f.pool.release("a");
    const pool = new AgentPool(
      f.file,
      [{ ...profile, model: "different" }],
      f.port,
      ["w1"],
    );
    await assert.rejects(
      pool.acquire("w1", "helper", lead, "b"),
      /configuration changed/,
    );
    assert.equal(f.starts, 1);
  } finally {
    f.close();
  }
});

test("bind adopts an existing persistent session without creating a pane", async () => {
  const f = fixture();
  try {
    const worker = {
      ...lead,
      pane_id: "w1:p7",
      terminal_id: "worker",
      agent_session: { kind: "id", value: "existing" },
    };
    f.set([lead, worker]);
    f.pool.select("w1", "helper", true);
    f.pool.bind("w1", "helper", worker);
    assert.equal(
      (await f.pool.acquire("w1", "helper", lead, "a")).continuity,
      "same-session",
    );
    assert.equal(f.starts, 0);
  } finally {
    f.close();
  }
});

test("profile validation rejects ambiguous IDs and unsupported model flags", () => {
  assert.throws(() => validateProfiles([profile, profile]), /unique/);
  assert.throws(
    () => validateProfiles([{ id: "helper", kind: "custom", model: "m" }]),
    /modelFlag/,
  );
  assert.throws(
    () =>
      validateProfiles([{ id: "helper", kind: "codex", args: ["bad\0arg"] }]),
    /invalid/,
  );
  assert.equal(validateProfiles([profile])[0].modelFlag, "-m");
});

// ISSUE-091：agent.start 回傳時 Agent 還沒被偵測到（沒有 agent 欄位、狀態 unknown），之後才變 idle。
test("a profile Agent that is still being detected right after start is waited for", async () => {
  const f = fixture();
  try {
    f.pool.select("w1", "helper", true);
    const observed: string[] = [];
    f.port.startProfile = async (_lead, _p, _name, onPane) => {
      onPane("w1:p2");
      const starting = {
        pane_id: "w1:p2",
        terminal_id: "worker-1",
        workspace_id: "w1",
        tab_id: "w1:t1",
        agent_status: "unknown",
      } as AgentRecord;
      f.agents().push(starting);
      // 約 0.6 秒後才被偵測成 codex，再過一下才 idle
      setTimeout(() => {
        Object.assign(starting, { agent: "codex", agent_status: "working" });
        observed.push("working");
      }, 600);
      setTimeout(() => {
        Object.assign(starting, { agent_status: "idle" });
        observed.push("idle");
      }, 1200);
      return { ...starting };
    };
    const got = await f.pool.acquire("w1", "helper", lead, "a");
    assert.equal(got.agent.agent, "codex");
    assert.equal(got.agent.agent_status, "idle");
    assert.deepEqual(observed, ["working", "idle"]);
    assert.equal(got.continuity, "new-session");
  } finally {
    f.close();
  }
});

test("a profile Agent that never becomes ready still fails with the original error", async () => {
  const f = fixture();
  const pool = new AgentPool(f.file, [profile], f.port, ["w1"], 700);
  try {
    pool.select("w1", "helper", true);
    f.port.startProfile = async (_lead, _p, _name, onPane) => {
      onPane("w1:p2");
      const stuck = {
        pane_id: "w1:p2",
        terminal_id: "worker-1",
        workspace_id: "w1",
        tab_id: "w1:t1",
        agent_status: "unknown",
      } as AgentRecord;
      f.agents().push(stuck);
      return { ...stuck };
    };
    await assert.rejects(
      pool.acquire("w1", "helper", lead, "a"),
      /does not match requested profile\/workspace or is not ready/,
    );
  } finally {
    f.close();
  }
});

test("a profile started as a different CLI fails immediately instead of waiting", async () => {
  const f = fixture();
  const pool = new AgentPool(f.file, [profile], f.port, ["w1"], 20000);
  try {
    pool.select("w1", "helper", true);
    f.port.startProfile = async (_lead, _p, _name, onPane) => {
      onPane("w1:p2");
      const other = {
        pane_id: "w1:p2",
        terminal_id: "worker-1",
        workspace_id: "w1",
        tab_id: "w1:t1",
        agent: "claude",
        agent_status: "idle",
      } as AgentRecord;
      f.agents().push(other);
      return { ...other };
    };
    const startedAt = Date.now();
    await assert.rejects(
      pool.acquire("w1", "helper", lead, "a"),
      /does not match requested profile/,
    );
    assert.ok(Date.now() - startedAt < 2000);
  } finally {
    f.close();
  }
});

// ISSUE-107：agy 啟動時沒有 session，處理完第一個回合後才被 Herdr 登記；經過驗證的回合結果要能更新綁定，
// 之後同一個 profile 才能再被 acquire（否則 unknown → known 會被當成 session 改變而拒絕）。
function agyFixture() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-pool-agy-"));
  const file = join(dir, "pool.json");
  const agy = { id: "agy", kind: "agy" };
  const agents: AgentRecord[] = [lead];
  const port = {
    listAgentsWithWorkspaceNames: async () => agents,
    startProfile: async (
      _lead: AgentRecord,
      _profile: unknown,
      _name: string,
      onPane: (id: string) => void,
    ) => {
      const a: AgentRecord = {
        ...lead,
        pane_id: "w1:p2",
        terminal_id: "agy-term",
        agent: "agy",
      };
      onPane(a.pane_id);
      agents.push(a);
      return a;
    },
  };
  const make = () => new AgentPool(file, [agy], port, ["w1"]);
  return {
    make,
    file,
    agents,
    live: () => agents.find((a) => a.pane_id === "w1:p2")!,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const s1 = { kind: "id", value: "agy-s1" };

test("a session that appears after the first validated turn is persisted, so the same profile can be acquired again", async () => {
  const f = agyFixture();
  try {
    const pool = f.make();
    pool.select("w1", "agy", true);
    const first = await pool.acquire("w1", "agy", lead, "task-1");
    assert.equal(first.continuity, "new-session");
    assert.equal(first.agent.agent_session, undefined);
    f.agents[1] = { ...f.live(), agent_session: s1 };
    assert.equal(
      await pool.refreshSession("w1", "agy", "task-1", first.agent, s1),
      true,
    );
    pool.release("task-1");
    // 重新載入持久化狀態後仍然認得這個 conversation。
    const again = await f.make().acquire("w1", "agy", lead, "task-2");
    assert.equal(again.continuity, "same-session");
    assert.deepEqual(again.agent.agent_session, s1);
  } finally {
    f.close();
  }
});

test("without a refresh, an unknown session that became known is still rejected at the next acquire", async () => {
  const f = agyFixture();
  try {
    const pool = f.make();
    pool.select("w1", "agy", true);
    await pool.acquire("w1", "agy", lead, "task-1");
    f.agents[1] = { ...f.live(), agent_session: s1 };
    pool.release("task-1");
    await assert.rejects(
      pool.acquire("w1", "agy", lead, "task-2"),
      /bound session identity changed/,
    );
  } finally {
    f.close();
  }
});

// 各 guard fixture 先滿足其餘前置條件，再單獨破壞被測條件。
type PoolInternals = {
  state: {
    sessions: Record<
      string,
      {
        uncertain?: boolean;
        fingerprint: string;
        agent?: AgentRecord;
      }
    >;
  };
};

async function guardFixture(kind = "agy") {
  const dir = mkdtempSync(join(tmpdir(), "bridge-pool-guard-"));
  const file = join(dir, "pool.json");
  const profile = { id: "p", kind };
  const agents: AgentRecord[] = [lead];
  const port = {
    listAgentsWithWorkspaceNames: async () => agents,
    startProfile: async (
      _lead: AgentRecord,
      _profile: unknown,
      _name: string,
      onPane: (id: string) => void,
    ) => {
      const a: AgentRecord = {
        ...lead,
        pane_id: "w1:p2",
        terminal_id: "p-term",
        agent: kind,
      };
      onPane(a.pane_id);
      agents.push(a);
      return a;
    },
  };
  const pool = new AgentPool(file, [profile], port, ["w1"]);
  pool.select("w1", "p", true);
  const first = await pool.acquire("w1", "p", lead, "task-1");
  const setLive = (patch: Partial<AgentRecord>) => {
    agents[1] = { ...agents[1], ...patch };
  };
  setLive({ agent_session: s1 });
  const binding = () =>
    (pool as unknown as PoolInternals).state.sessions["w1/p"];
  const persisted = () =>
    (JSON.parse(readFileSync(file, "utf8")) as PoolInternals["state"]).sessions[
      "w1/p"
    ]?.agent?.agent_session;
  return {
    pool,
    worker: first.agent,
    port,
    setLive,
    binding,
    persisted,
    dropLive: () => agents.splice(1, 1),
    refresh: (
      worker: AgentRecord = first.agent,
      owner = "task-1",
      session: { kind: string; value: string } = s1,
    ) => pool.refreshSession("w1", "p", owner, worker, session),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("refresh baseline: with every precondition satisfied the unknown session is persisted", async () => {
  const f = await guardFixture();
  try {
    assert.equal(await f.refresh(), true);
    assert.deepEqual(f.persisted(), s1);
  } finally {
    f.close();
  }
});

test("refresh guard: a caller without the lease is refused (released, or another owner)", async () => {
  const f = await guardFixture();
  try {
    assert.equal(await f.refresh(f.worker, "someone-else"), false);
    f.pool.release("task-1");
    assert.equal(await f.refresh(), false);
    assert.equal(f.persisted(), undefined);
  } finally {
    f.close();
  }
});

test("refresh guard: an uncertain binding is refused", async () => {
  const f = await guardFixture();
  try {
    f.binding().uncertain = true;
    assert.equal(await f.refresh(), false);
    assert.equal(f.persisted(), undefined);
  } finally {
    f.close();
  }
});

test("refresh guard: a binding made for a different profile configuration is refused", async () => {
  const f = await guardFixture();
  try {
    f.binding().fingerprint = JSON.stringify({
      id: "p",
      kind: "agy",
      args: ["--other"],
    });
    assert.equal(await f.refresh(), false);
    assert.equal(f.persisted(), undefined);
  } finally {
    f.close();
  }
});

test("refresh guard: a worker on a different pane than the binding is refused", async () => {
  const f = await guardFixture();
  try {
    assert.equal(await f.refresh({ ...f.worker, pane_id: "w1:p9" }), false);
    assert.equal(f.persisted(), undefined);
  } finally {
    f.close();
  }
});

test("refresh guard: a worker with a different terminal than the binding is refused", async () => {
  const f = await guardFixture();
  try {
    assert.equal(await f.refresh({ ...f.worker, terminal_id: "other" }), false);
    assert.equal(f.persisted(), undefined);
  } finally {
    f.close();
  }
});

test("refresh guard: a worker record from another workspace is refused", async () => {
  const f = await guardFixture();
  try {
    assert.equal(await f.refresh({ ...f.worker, workspace_id: "w2" }), false);
    assert.equal(f.persisted(), undefined);
  } finally {
    f.close();
  }
});

test("refresh guard: a worker record of another CLI kind is refused", async () => {
  const f = await guardFixture();
  try {
    assert.equal(await f.refresh({ ...f.worker, agent: "claude" }), false);
    assert.equal(f.persisted(), undefined);
  } finally {
    f.close();
  }
});

test("refresh guard: a binding whose stored Agent has another terminal, workspace or kind is refused", async () => {
  for (const patch of [
    { terminal_id: "other" },
    { workspace_id: "w2" },
    { agent: "claude" },
  ]) {
    const f = await guardFixture();
    try {
      f.binding().agent = { ...f.binding().agent!, ...patch };
      assert.equal(await f.refresh(), false, JSON.stringify(patch));
      assert.equal(f.persisted(), undefined);
    } finally {
      f.close();
    }
  }
});

test("refresh guard: a session without a kind of id/path or without a value is refused", async () => {
  const f = await guardFixture();
  try {
    assert.equal(
      await f.refresh(f.worker, "task-1", { kind: "id", value: "" }),
      false,
    );
    assert.equal(
      await f.refresh(f.worker, "task-1", { kind: "other", value: "agy-s1" }),
      false,
    );
    assert.equal(f.persisted(), undefined);
  } finally {
    f.close();
  }
});

test("refresh guard: a live pane that no longer exists is refused", async () => {
  const f = await guardFixture();
  try {
    f.dropLive();
    assert.equal(await f.refresh(), false);
    assert.equal(f.persisted(), undefined);
  } finally {
    f.close();
  }
});

test("refresh guard: a live pane whose terminal, workspace or kind changed is refused", async () => {
  for (const patch of [
    { terminal_id: "other" },
    { workspace_id: "w2" },
    { agent: "claude" },
  ]) {
    const f = await guardFixture();
    try {
      f.setLive(patch);
      assert.equal(await f.refresh(), false, JSON.stringify(patch));
      assert.equal(f.persisted(), undefined);
    } finally {
      f.close();
    }
  }
});

test("refresh guard: a live pane whose session vanished is refused", async () => {
  const f = await guardFixture();
  try {
    f.setLive({ agent_session: undefined });
    assert.equal(await f.refresh(), false);
    assert.equal(f.persisted(), undefined);
  } finally {
    f.close();
  }
});

test("refresh guard: a live pane that reports a different session than the one reported is refused", async () => {
  const f = await guardFixture();
  try {
    f.setLive({ agent_session: { kind: "id", value: "agy-other" } });
    assert.equal(await f.refresh(), false);
    assert.equal(f.persisted(), undefined);
  } finally {
    f.close();
  }
});

test("refresh guard: a binding that already has a known session is never replaced, including s1 to s2", async () => {
  const f = await guardFixture();
  try {
    f.binding().agent = { ...f.binding().agent!, agent_session: s1 };
    const s2 = { kind: "id", value: "agy-s2" };
    f.setLive({ agent_session: s2 });
    assert.equal(await f.refresh(f.worker, "task-1", s2), false);
    assert.deepEqual(f.binding().agent?.agent_session, s1);
    // 已有 session，即使相同也拒絕，且不會改動
    f.setLive({ agent_session: s1 });
    assert.equal(await f.refresh(), false);
    assert.deepEqual(f.binding().agent?.agent_session, s1);
  } finally {
    f.close();
  }
});

test("refresh guard: a codex profile is refused even when every other precondition holds", async () => {
  const f = await guardFixture("codex");
  try {
    assert.equal(await f.refresh(), false);
    assert.equal(f.persisted(), undefined);
  } finally {
    f.close();
  }
});

test("refresh rechecks reservation and binding after the live lookup", async () => {
  for (const change of ["release", "binding"] as const) {
    const f = await guardFixture();
    try {
      const list = f.port.listAgentsWithWorkspaceNames;
      f.port.listAgentsWithWorkspaceNames = async () => {
        if (change === "release") f.pool.release("task-1");
        else f.binding().agent = { ...f.worker, terminal_id: "replacement" };
        return list();
      };
      assert.equal(await f.refresh(), false);
      assert.equal(f.persisted(), undefined);
      assert.equal(f.binding().agent?.agent_session, undefined);
    } finally {
      f.close();
    }
  }
});

test("passive usage profile lookup requires a known matching session and never starts a CLI", () => {
  const f = fixture();
  try {
    f.pool.select("w1", "helper", true);
    f.pool.bind("w1", "helper", lead);
    assert.equal(f.pool.passiveProfilePane("w1", "helper", [lead]), undefined);
    const known = { ...lead, agent_session: { kind: "id", value: "known" } };
    f.pool.bind("w1", "helper", known);
    assert.equal(f.pool.passiveProfilePane("w1", "helper", [known]), known);
    assert.equal(
      f.pool.passiveProfilePane("w1", "helper", [
        { ...known, agent_session: { kind: "id", value: "replacement" } },
      ]),
      undefined,
    );
    assert.equal(f.pool.passiveProfilePane("w2", "helper", [known]), undefined);
    assert.equal(f.starts, 0);
  } finally {
    f.close();
  }
});
