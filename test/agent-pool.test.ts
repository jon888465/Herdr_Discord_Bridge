import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
