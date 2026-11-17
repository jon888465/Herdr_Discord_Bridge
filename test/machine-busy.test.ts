import test from "node:test";
import assert from "node:assert/strict";
import { machineBusyReason } from "../src/machine-busy.js";

test("busy reason covers active prefix, pane prefix, machine field, pending and terminal dedup", () => {
  assert.equal(
    machineBusyReason("pod", {
      activeTerminals: ["pod:t1", "pod2:t2", "local"],
      pool: {
        leases: [
          { key: "a", paneId: "pod:p1", terminalId: "pod:t1" },
          { key: "b", paneId: "pod:p2", terminalId: "t2" },
          { key: "c", machine: "pod", terminalId: "t3" },
        ],
        pending: [
          { key: "d", workspace: "pod:w1" },
          { key: "b", paneId: "pod:p2", terminalId: "t2" },
        ],
      },
    }),
    "4 個進行中的回合",
  );
  assert.equal(
    machineBusyReason("pod", {
      activeTerminals: ["pod2:t"],
      pool: { leases: [], pending: [{ key: "local/a", workspace: "local" }] },
    }),
    undefined,
  );
});
