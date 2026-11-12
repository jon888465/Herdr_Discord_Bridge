import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const fakeEnvironmentToken = "fake-env-secret";
const fakeOtherToken = "fake-other-secret";

interface Call {
  cli: string;
  args: string[];
}
function runFixture(
  args: string[],
  scenario = "running",
  built = true,
  settings: {
    runtime?: string;
    env?: Record<string, string>;
    fileToken?: string;
    customDirs?: boolean;
    noConfigFile?: boolean;
    pluginInstall?: "config" | "config+state";
  } = {},
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "run backend "));
  try {
    const bin = path.join(directory, "bin");
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(directory, "scripts"));
    fs.writeFileSync(
      path.join(directory, "scripts/run.sh"),
      fs.readFileSync("scripts/run.sh"),
    );
    if (built) {
      fs.mkdirSync(path.join(directory, "dist/src"), { recursive: true });
      fs.writeFileSync(
        path.join(directory, "dist/src/index.js"),
        "// fake build",
      );
    }
    const configDir = settings.customDirs
      ? path.join(directory, "custom config")
      : path.join(directory, ".config/herdr-discord-bridge");
    const stateDir = settings.customDirs
      ? path.join(directory, "custom state")
      : path.join(configDir, "state");
    fs.mkdirSync(configDir, { recursive: true });
    if (!settings.noConfigFile)
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        "// JSONC\n" +
          JSON.stringify({
            runtime: settings.runtime,
            discord: { botToken: settings.fileToken ?? "" },
          }),
      );
    if (settings.pluginInstall) {
      const pluginConfigDir = path.join(
        directory,
        ".config/herdr/plugins/config/herdr-discord-bridge",
      );
      fs.mkdirSync(pluginConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginConfigDir, "config.json"),
        JSON.stringify({ discord: { botToken: "fake-file-secret" } }),
      );
      if (settings.pluginInstall === "config+state")
        fs.mkdirSync(
          path.join(directory, ".local/state/herdr/plugins/herdr-discord-bridge"),
          { recursive: true },
        );
    }
    const dump = path.join(directory, "environment.json");
    fs.writeFileSync(
      path.join(bin, "node"),
      `#!/bin/sh
if [ "$1" = '${directory}/dist/src/index.js' ] || [ "$1" = '${fs.realpathSync(directory)}/dist/src/index.js' ]; then
  exec '${process.execPath}' -e 'require("node:fs").writeFileSync(process.argv[1],JSON.stringify(process.env))' '${dump}'
fi
exec '${process.execPath}' "$@"
`,
      { mode: 0o700 },
    );
    const log = path.join(directory, "calls.jsonl");
    fs.writeFileSync(log, "");
    const source = `#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');
const cli=path.basename(process.argv[1]);const args=process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS,JSON.stringify({cli,args})+'\\n');
const scenario=process.env.TEST_SCENARIO;const root=fs.realpathSync(process.cwd());
const output=x=>console.log(JSON.stringify(x));
if(cli==='npm') {if(args.join(' ')==='run build') {fs.mkdirSync('dist/src',{recursive:true});fs.writeFileSync('dist/src/index.js','// fake');}process.exit(0);}
if(cli==='herdr-core') {
 if(args[0]==='server'&&args[1]==='status') {
  if(scenario==='permission') {output({error:{kind:'permission',message:'permission denied'}});process.exit(1);}
  if(scenario==='incompatible') {output({error:{kind:'incompatible',message:'incompatible protocol'}});process.exit(1);}
  if(scenario==='bad-status') {console.log('{}');process.exit(0);}
  if((scenario==='stopped'||scenario==='never-ready')&&!fs.existsSync(root+'/started')) {output({error:{kind:'not_running',message:'no core running'}});process.exit(1);}
  output({version:'0.1.20',core:{id:'fake-core'}});process.exit(0);
 }
 if(args[0]==='server'&&args[1]==='start') {if(scenario!=='never-ready')fs.writeFileSync(root+'/started','1');output({started:true});process.exit(0);}
 if(args[0]==='ls') {
  if(scenario==='bad-list') {console.log('{}');process.exit(0);}
  const terminal={address:'t8',state:'live',labels:{'bridge.role':'discord-bridge','bridge.project':root}};
  if(scenario==='other-project')terminal.labels['bridge.project']='/somewhere/else';
  if(scenario==='finished')terminal.state='finished';
  if(scenario==='compact')delete terminal.labels;
  output({terminals:['existing','compact','other-project','finished'].includes(scenario)?[terminal]:[]});process.exit(0);
 }
 if(args[0]==='get') {output({address:args[1],state:'live',labels:{'bridge.role':'discord-bridge','bridge.project':root}});process.exit(0);}
 if(args[0]==='run') {
  if(scenario==='clean-launch') {const tail=args.slice(args.indexOf('--')+1);const result=require('node:child_process').spawnSync('/usr/bin/env',['-i','PATH='+process.env.PATH,...tail],{encoding:'utf8'});if(result.status!==0)throw new Error('clean launch failed');}
  output(scenario==='bad-run'?{}:{address:'t9'});process.exit(0);
 }
 console.error('unexpected Core command');process.exit(99);
}
if(cli==='herdr') {
 if(args[0]==='plugin'&&args[1]==='config-dir') {console.log(process.env.TEST_CONFIG);process.exit(0);}
 if(scenario==='clean-launch'&&args[0]==='plugin'&&args[1]==='pane') {
  const setting=args[args.indexOf('--env')+1];
  const r=require('node:child_process').spawnSync('/usr/bin/env',['-i','PATH='+process.env.PATH,setting,'node',root+'/dist/src/index.js'],{encoding:'utf8'});if(r.status!==0)throw new Error('plugin launch failed');
 }

 if(args.join(' ')==='status server'){console.log('status: running');process.exit(0);}
 let result={};
 if(args[0]==='workspace'&&args[1]==='list')result={workspaces:[{workspace_id:'w3',label:'bridge'}]};
 if(args[0]==='pane'&&args[1]==='list')result={panes:[{pane_id:'w3:p1',workspace_id:'w3',tab_id:'w3:t1',agent:'codex'}]};
 if(args[0]==='tab'&&args[1]==='list')result={tabs:[{workspace_id:'w3',tab_id:'w3:t1',number:1}]};
 if(args[0]==='plugin'&&args[1]==='pane')result={pane:{pane_id:'w3:p5'}};
 output({result});process.exit(0);
}
process.exit(99);
`;
    for (const cli of ["herdr", "herdr-core", "npm"])
      fs.writeFileSync(path.join(bin, cli), source, { mode: 0o700 });
    const result = spawnSync(
      "/bin/bash",
      [path.join(directory, "scripts/run.sh"), ...args],
      {
        env: {
          ...process.env,
          HOME: directory,
          HERDR_PLUGIN_CONFIG_DIR: settings.customDirs ? configDir : "",
          HERDR_PLUGIN_STATE_DIR: settings.customDirs ? stateDir : "",
          HERDR_DISCORD_BOT_TOKEN: "",
          DISCORD_BOT_TOKEN: "",
          HC_SOCKET: undefined,
          HC_SESSION: undefined,
          ...settings.env,
          PATH: `${bin}:${process.env.PATH}`,
          TEST_CONFIG: configDir,
          TEST_CALLS: log,
          TEST_SCENARIO: scenario,
        },
        encoding: "utf8",
        timeout: 16000,
      },
    );
    assert.equal(result.error, undefined, result.error?.message);
    const calls = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Call);
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls,
      project: fs.realpathSync(directory),
      // run.sh reads $HOME as given (not canonicalized; differs on macOS /var).
      home: directory,
      configDir,
      stateDir,
      childEnv: fs.existsSync(dump)
        ? (JSON.parse(fs.readFileSync(dump, "utf8")) as Record<string, string>)
        : undefined,
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const args of [
  [],
  ["-r"],
  ["-rg"],
  ["--herdr"],
  ["--herdr", "-r"],
  ["-r", "--herdr"],
  ["--herdr", "-rg"],
  ["-rg", "--herdr"],
])
  test(`run.sh Herdr matrix ${args.join(" ") || "default"}`, () => {
    const result = runFixture(args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(
      result.calls.some((call) => call.cli === "herdr-core"),
      false,
    );
    assert.ok(
      result.calls.some(
        (call) =>
          call.cli === "herdr" &&
          call.args.join(" ").startsWith("plugin pane open"),
      ),
    );
    if (args.includes("-r"))
      assert.deepEqual(
        result.calls
          .filter((call) => call.cli === "npm")
          .map((call) => call.args),
        [["ci"], ["run", "build"]],
      );
    if (args.includes("-rg"))
      assert.ok(
        result.calls.some(
          (call) =>
            call.cli === "herdr" &&
            call.args.join(" ") ===
              "plugin install jon888465/Herdr_Discord_Bridge --ref main --yes",
        ),
      );
  });

for (const args of [["--core"], ["-r", "--core"], ["--core", "-r"]])
  test(`run.sh Core matrix ${args.join(" ")}`, () => {
    const result = runFixture(args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Core bridge terminal: t9/);
    assert.equal(
      result.calls.some((call) => call.cli === "herdr"),
      false,
    );
    const run = result.calls.find(
      (call) => call.cli === "herdr-core" && call.args[0] === "run",
    )!;
    assert.deepEqual(run.args, [
      "run",
      "--json",
      "--bg",
      "--no-parent",
      "--no-notify",
      "--cwd",
      result.project,
      "--label",
      "bridge.role=discord-bridge",
      "--label",
      "bridge.backend=core",
      "--label",
      `bridge.project=${result.project}`,
      "--",
      "env",
      "-u",
      "HERDR_DISCORD_BOT_TOKEN",
      "-u",
      "DISCORD_BOT_TOKEN",
      "-u",
      "HC_SOCKET",
      "-u",
      "HC_SESSION",
      "HERDR_BRIDGE_RUNTIME=core",
      `HERDR_PLUGIN_CONFIG_DIR=${result.configDir}`,
      `HERDR_PLUGIN_STATE_DIR=${result.stateDir}`,
      "node",
      `${result.project}/dist/src/index.js`,
    ]);
    assert.deepEqual(
      result.calls
        .filter((call) => call.cli === "npm")
        .map((call) => call.args),
      args.includes("-r") ? [["ci"], ["run", "build"]] : [],
    );
    assert.equal(
      result.calls.some(
        (call) =>
          call.cli === "herdr-core" &&
          ["stop", "restart", "kill", "rm"].some((word) =>
            call.args.includes(word),
          ),
      ),
      false,
    );
  });

for (const args of [
  ["--core", "--herdr"],
  ["--herdr", "--herdr"],
  ["--core", "--core"],
  ["-r", "-rg"],
  ["-r", "-r"],
  ["-rg", "-rg"],
  ["--core", "-rg"],
  ["-rg", "--core"],
  ["--bogus"],
  ["position"],
])
  test(`run.sh 拒絕 ${args.join(" ")} 且零副作用`, () => {
    const result = runFixture(args);
    assert.equal(result.status, 2);
    assert.match(
      result.stderr,
      /Usage: scripts\/run.sh \[--herdr\|--core\] \[-r\|-rg\]/,
    );
    assert.deepEqual(result.calls, []);
  });
for (const flag of ["--help", "-h"])
  test(`run.sh ${flag} 零副作用`, () => {
    const result = runFixture([flag]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Backend defaults to --herdr/);
    assert.deepEqual(result.calls, []);
  });

for (const [args, customDirs] of [
  [["--core"], false],
  [["--core", "-r"], false],
  [["-r", "--core"], true],
] as const)
  test(`Core 設定檔不存在時在任何 CLI 呼叫前拒絕 ${args.join(" ")} custom=${customDirs}`, () => {
    const result = runFixture([...args], "running", true, {
      noConfigFile: true,
      customDirs,
      env: { HERDR_DISCORD_BOT_TOKEN: fakeEnvironmentToken },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Core bridge config not found: /);
    assert.ok(
      result.stderr.includes(path.join(result.configDir, "config.json")),
      result.stderr,
    );
    assert.match(result.stderr, /HERDR_PLUGIN_CONFIG_DIR/);
    assert.doesNotMatch(result.stderr, /Found Herdr plugin config/);
    assert.deepEqual(result.calls, []);
    assert.equal(result.childEnv, undefined);
    assert.doesNotMatch(result.stderr, /fake-env-secret/);
  });
for (const [pluginInstall, args] of [
  ["config", ["--core"]],
  ["config+state", ["--core", "-r"]],
  ["config+state", ["--core"]],
] as const)
  test(`standalone 目錄沒有設定時 Core 改用 Herdr plugin 設定與 state 目錄 ${pluginInstall} ${args.join(" ")}`, () => {
    const result = runFixture([...args], "clean-launch", true, {
      noConfigFile: true,
      pluginInstall,
    });
    assert.equal(result.status, 0, result.stderr);
    const home = result.home;
    const pluginConfigDir = `${home}/.config/herdr/plugins/config/herdr-discord-bridge`;
    const pluginStateDir = `${home}/.local/state/herdr/plugins/herdr-discord-bridge`;
    assert.ok(
      result.stdout.includes(
        `Using Herdr plugin config: ${pluginConfigDir}/config.json (state: ${pluginStateDir})`,
      ),
      result.stdout,
    );
    assert.doesNotMatch(result.stderr, /Core bridge config not found/);
    assert.equal(result.childEnv?.HERDR_PLUGIN_CONFIG_DIR, pluginConfigDir);
    assert.equal(result.childEnv?.HERDR_PLUGIN_STATE_DIR, pluginStateDir);
    assert.equal(result.childEnv?.HERDR_BRIDGE_RUNTIME, "core");
    assert.equal(result.calls.at(-1)?.args[0], "run");
    assert.doesNotMatch(
      JSON.stringify(result.calls) + result.stdout + result.stderr,
      /fake-file-secret/,
    );
  });
test("standalone 目錄沒有設定但 caller 指定 HERDR_PLUGIN_STATE_DIR 時保留該 state 目錄", () => {
  const result = runFixture(["--core"], "clean-launch", true, {
    noConfigFile: true,
    pluginInstall: "config",
    env: { HERDR_PLUGIN_STATE_DIR: "/tmp/custom core state" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.childEnv?.HERDR_PLUGIN_CONFIG_DIR,
    `${result.home}/.config/herdr/plugins/config/herdr-discord-bridge`,
  );
  assert.equal(result.childEnv?.HERDR_PLUGIN_STATE_DIR, "/tmp/custom core state");
});
for (const [pluginInstall, args] of [
  ["config", ["--core"]],
  ["config+state", ["--core", "-r"]],
] as const)
  test(`明確指定的目錄沒有設定時不改用 plugin 設定，只印路徑與重跑指令 ${pluginInstall} ${args.join(" ")}`, () => {
    const result = runFixture([...args], "running", true, {
      noConfigFile: true,
      customDirs: true,
      pluginInstall,
    });
    assert.equal(result.status, 1);
    const home = result.home;
    const pluginConfigDir = `${home}/.config/herdr/plugins/config/herdr-discord-bridge`;
    const pluginStateDir = `${home}/.local/state/herdr/plugins/herdr-discord-bridge`;
    assert.match(result.stderr, /Core bridge config not found: /);
    assert.ok(
      result.stderr.includes(`Found Herdr plugin config: ${pluginConfigDir}/config.json`),
      result.stderr,
    );
    const rerun = result.stderr
      .split("\n")
      .find((line) => line.startsWith("Rerun with: "));
    assert.ok(rerun, result.stderr);
    assert.ok(rerun.includes(`HERDR_PLUGIN_CONFIG_DIR=${pluginConfigDir} `), rerun);
    assert.equal(
      rerun.includes(`HERDR_PLUGIN_STATE_DIR=${pluginStateDir} `),
      pluginInstall === "config+state",
      rerun,
    );
    assert.ok(rerun.endsWith(` scripts/run.sh ${args.join(" ")}`), rerun);
    // Only a hint: the plugin config is not read, no CLI runs, no token leaks.
    assert.deepEqual(result.calls, []);
    assert.equal(result.childEnv, undefined);
    assert.doesNotMatch(result.stderr, /fake-file-secret/);
  });
test("Core 未 build 時提示 -r 且零 CLI 呼叫", () => {
  const result = runFixture(["--core"], "running", false);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--core -r/);
  assert.deepEqual(result.calls, []);
});
test("Core -r 可建立缺少的 build", () => {
  const result = runFixture(["--core", "-r"], "running", false);
  assert.equal(result.status, 0, result.stderr);
});
test("Core 明確未啟動才 start 一次", () => {
  const result = runFixture(["--core"], "stopped");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.calls.filter(
      (call) =>
        call.cli === "herdr-core" && call.args.join(" ") === "server start",
    ).length,
    1,
  );
});
for (const scenario of ["permission", "incompatible", "bad-status"])
  test(`Core ${scenario} 不可當未啟動`, () => {
    const result = runFixture(["--core"], scenario);
    assert.equal(result.status, 1);
    assert.equal(
      result.calls.some((call) => call.args.includes("start")),
      false,
    );
    assert.equal(
      result.calls.some((call) => call.args[0] === "run"),
      false,
    );
  });
for (const scenario of ["existing", "compact"])
  test(`Core ${scenario} 同專案 bridge 拒絕且不關資源`, () => {
    const result = runFixture(["--core"], scenario);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /t8/);
    assert.equal(
      result.calls.some((call) => ["run", "kill", "rm"].includes(call.args[0])),
      false,
    );
    assert.equal(
      result.calls.some((call) => call.cli === "herdr"),
      false,
    );
    if (scenario === "compact")
      assert.ok(result.calls.some((call) => call.args[0] === "get"));
  });
for (const scenario of ["finished", "other-project"])
  test(`Core ${scenario} 不關閉且可啟動`, () => {
    const result = runFixture(["--core"], scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.calls.some((call) => ["kill", "rm"].includes(call.args[0])),
      false,
    );
  });
for (const scenario of ["bad-list", "bad-run"])
  test(`Core ${scenario} 回應不完整明確失敗`, () => {
    const result = runFixture(["--core"], scenario);
    assert.equal(result.status, 1);
    if (scenario === "bad-list")
      assert.equal(
        result.calls.some((call) => call.args[0] === "run"),
        false,
      );
  });

test("Core readiness 等待有界，未就緒不 run 且只 start 一次", () => {
  const started = Date.now();
  const result = runFixture(["--core"], "never-ready");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /within 10 seconds/);
  assert.ok(Date.now() - started < 13000);
  assert.equal(
    result.calls.filter(
      (call) =>
        call.cli === "herdr-core" && call.args.join(" ") === "server start",
    ).length,
    1,
  );
  assert.equal(
    result.calls.some(
      (call) => call.cli === "herdr-core" && call.args[0] === "run",
    ),
    false,
  );
});

for (const args of [[], ["--herdr"]])
  test(`r7-f1 launcher env 固定 Herdr，忽略 Core config／呼叫端 ${args.join(" ")}`, () => {
    const result = runFixture(args, "clean-launch", true, {
      runtime: "core",
      env: { HERDR_BRIDGE_RUNTIME: "core" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.childEnv?.HERDR_BRIDGE_RUNTIME, "herdr");
    assert.equal(
      result.calls.some((call) => call.cli === "herdr-core"),
      false,
    );
    assert.ok(
      result.calls
        .find((call) => call.cli === "herdr" && call.args[1] === "pane")
        ?.args.includes("HERDR_BRIDGE_RUNTIME=herdr"),
    );
  });
for (const runtime of [undefined, "herdr"])
  test(`r7-f1 原 Herdr config ${runtime ?? "missing"} 保持可啟動`, () => {
    const result = runFixture(["--herdr"], "running", true, { runtime });
    assert.equal(result.status, 0, result.stderr);
  });

for (const customDirs of [false, true])
  test(`r7-f2 清空 Core server 環境仍傳入相同定位與目錄 custom=${customDirs}`, () => {
    const result = runFixture(["--core"], "clean-launch", true, {
      customDirs,
      fileToken: "fake-file-secret",
      env: {
        HC_SOCKET: "/tmp/x.sock",
        HC_SESSION: "chosen",
        HERDR_DISCORD_BOT_TOKEN: fakeEnvironmentToken,
        DISCORD_BOT_TOKEN: fakeOtherToken,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.childEnv?.HERDR_BRIDGE_RUNTIME, "core");
    assert.equal(result.childEnv?.HERDR_PLUGIN_CONFIG_DIR, result.configDir);
    assert.equal(result.childEnv?.HERDR_PLUGIN_STATE_DIR, result.stateDir);
    assert.equal(result.childEnv?.HC_SOCKET, "/tmp/x.sock");
    assert.equal(result.childEnv?.HC_SESSION, "chosen");
    assert.equal(result.childEnv?.HERDR_DISCORD_BOT_TOKEN, undefined);
    assert.equal(result.childEnv?.DISCORD_BOT_TOKEN, undefined);
    assert.doesNotMatch(
      JSON.stringify(result.calls) + result.stdout + result.stderr,
      /fake-(file|env|other)-secret/,
    );
  });
for (const field of ["HERDR_DISCORD_BOT_TOKEN", "DISCORD_BOT_TOKEN"])
  test(`r7-f2 ${field} 僅環境 token 明確拒絕且零 CLI`, () => {
    const result = runFixture(["--core"], "running", true, {
      env: { [field]: "fake-env-secret" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Core 模式需把 token 放在 config 檔/);
    assert.deepEqual(result.calls, []);
    assert.doesNotMatch(result.stderr, /fake-env-secret/);
  });
