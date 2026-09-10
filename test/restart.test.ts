import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

for (const scenario of ["existing", "create", "ambiguous", "legacy"]) {
  test(`restart uses dedicated bridge workspace: ${scenario}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-restart-"));
    try {
      const log = join(dir, "calls.jsonl");
      writeFileSync(
        join(dir, "herdr"),
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BRIDGE_TEST_LOG, JSON.stringify(args)+'\\n');
const scenario = process.env.BRIDGE_TEST_SCENARIO;
const panes = [
 {pane_id:'w3:p1',tab_id:'w3:t1',workspace_id:'w3'},
 {pane_id:'w1:p6',tab_id:'w1:t6',workspace_id:'w1'},
 {pane_id:'w1:p1',tab_id:'w1:t1',workspace_id:'w1',agent:'agy'},
 {pane_id:'w2:p1',tab_id:'w2:t1',workspace_id:'w2',agent:'codex'},
 {pane_id:'w2:p2',tab_id:'w2:t1',workspace_id:'w2',agent:'agy'},
 {pane_id:scenario==='legacy'?'w2:p3':'w3:p3',tab_id:scenario==='legacy'?'w2:t1':'w3:t1',workspace_id:scenario==='legacy'?'w2':'w3',label:'Discord bridge'}
].filter(p => scenario !== 'create' || p.label !== 'Discord bridge');
const tabs = [
 {tab_id:'w3:t1',workspace_id:'w3',number:1,label:'1'},
 {tab_id:'w1:t1',workspace_id:'w1',number:1,label:'1'},
 {tab_id:'w1:t6',workspace_id:'w1',number:6,label:'Agents'},
 {tab_id:'w2:t1',workspace_id:'w2',number:1,label:'1'}
];
let result = {};
if(args[0]==='workspace' && args[1]==='list') result={workspaces: scenario==='create' ? [] : scenario==='ambiguous' ? [{workspace_id:'w3',label:'bridge'},{workspace_id:'w4',label:'bridge'}] : [{workspace_id:'w3',label:'bridge'}]};
if(args[0]==='workspace' && args[1]==='create') result={workspace:{workspace_id:'w3',label:'bridge'}};
if(args.join(' ')==='status server') { console.log('status: running'); process.exit(0); }
if(args[0]==='pane' && args[1]==='list') result={panes};
if(args[0]==='tab' && args[1]==='list') result={tabs};
if(args[0]==='tab' && args[1]==='create') result={tab:{tab_id:'w1:t7'},root_pane:{pane_id:'w1:p7'}};
if(args[0]==='agent' && args[1]==='list') result={agents:panes.filter(p=>p.agent)};
if(args[0]==='pane' && args[1]==='split') result={pane:{pane_id:'w2:p4'}};
if(args[0]==='plugin' && args[1]==='pane') result={pane:{pane_id:'w3:p5'}};
if(args[0]==='pane' && args[1]==='move') result={};
console.log(JSON.stringify({result}));
`,
        { mode: 0o700 },
      );
      const run = spawnSync("bash", [resolve("scripts/run.sh")], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          HERDR_WORKSPACE_ID: "w2",
          BRIDGE_TEST_LOG: log,
          BRIDGE_TEST_SCENARIO: scenario,
        },
        encoding: "utf8",
        timeout: 20000,
      });
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      if (scenario === "ambiguous" || scenario === "legacy") {
        assert.notEqual(run.status, 0);
        assert.ok(
          !calls.some((args) => ["close", "move", "create"].includes(args[1])),
        );
        return;
      }
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const created = calls.filter(
        (args) => args[0] === "workspace" && args[1] === "create",
      );
      assert.equal(created.length, scenario === "create" ? 1 : 0);
      if (created.length) {
        assert.ok(created[0].includes("bridge"));
        assert.ok(created[0].includes("--no-focus"));
      }

      const moved = calls.filter(
        (args) => args[0] === "pane" && args[1] === "move",
      );
      assert.deepEqual(
        moved.map((args) => args[2]),
        ["w3:p5"],
      );
      assert.ok(moved[0].includes("w3:t1"));
      assert.deepEqual(
        calls
          .filter((args) => args[0] === "pane" && args[1] === "close")
          .map((args) => args[2]),
        scenario === "create" ? [] : ["w3:p3"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
