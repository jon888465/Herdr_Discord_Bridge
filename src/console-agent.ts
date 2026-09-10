import type { HerdrClient } from "./herdr.js";
import type { AgentRecord, TargetMapping } from "./types.js";
import { agentLabel } from "./types.js";
import { agentHeader, stripAnsi } from "./format.js";
import { sameAgentSession } from "./response-stream.js";

type Port = Pick<
  HerdrClient,
  "listAgentsWithWorkspaceNames" | "readAgent" | "promptAgent" | "sendAgent"
>;
type Selection = Pick<TargetMapping, "workspaceId" | "paneId">;

/** Local visible snapshots of one selected pane, not a transcript or Discord relay. */
export class ConsoleAgent {
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private sending = false;
  private epoch = 0;
  private key = "";
  private pinned?: AgentRecord;
  private shown?: { text: string; status: string; seq: unknown };
  private lastError = "";
  private consumedQuestion = "";
  private stopped = false;

  constructor(
    private readonly herdr: Port,
    private readonly selected: () => Promise<Selection | undefined>,
    private readonly allowed: string[],
    private readonly print: (text: string) => void,
  ) {}

  start(intervalMs: number): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.reset();
  }

  reset(): void {
    this.epoch++;
    this.key = "";
    this.pinned = undefined;
    this.shown = undefined;
    this.consumedQuestion = "";
  }

  private async target(): Promise<AgentRecord | undefined> {
    const entered = this.epoch;
    const selected = await this.selected();
    if (this.stopped || entered !== this.epoch)
      throw new Error("selection changed; try again");
    if (!selected?.paneId) {
      this.reset();
      return;
    }
    if (this.allowed.length && !this.allowed.includes(selected.workspaceId))
      throw new Error("workspace is not authorized");
    const key = `${selected.workspaceId}/${selected.paneId}`;
    if (key !== this.key) {
      this.reset();
      this.key = key;
    }
    const epoch = this.epoch;
    const live = (await this.herdr.listAgentsWithWorkspaceNames()).find(
      (a) =>
        a.pane_id === selected.paneId &&
        a.workspace_id === selected.workspaceId,
    );
    if (epoch !== this.epoch) throw new Error("selection changed; try again");
    if (!live)
      throw new Error("selected Agent exited; use agent use <pane> again");
    if (this.pinned && !sameIdentity(this.pinned, live))
      throw new Error(
        "selected Agent session changed; use agent use <pane> again",
      );
    this.pinned = structuredClone(live);
    return live;
  }

  private async snapshot(agent: AgentRecord): Promise<string> {
    return stripAnsi(await this.herdr.readAgent(agent.pane_id, "visible", 40))
      .replace(/\r\n?/g, "\n")
      .trim()
      .split("\n")
      .slice(-40)
      .join("\n")
      .slice(-6000);
  }

  private show(agent: AgentRecord, text: string): void {
    if (
      this.shown?.text === text &&
      this.shown.status === agent.agent_status &&
      this.shown.seq === agent.state_change_seq
    )
      return;
    this.print(
      `${agentHeader(agentLabel(agent), agent.workspace_id, agent.pane_id)}\n[${agent.agent_status}] Terminal snapshot (last 40 visible lines)\n${text || "(no visible output)"}${agent.agent_status === "blocked" ? "\nWaiting for your answer: ask <answer>. Control commands remain available." : ""}`,
    );
    this.shown = {
      text,
      status: agent.agent_status,
      seq: agent.state_change_seq,
    };
    if (agent.agent_status !== "blocked") this.consumedQuestion = "";
  }

  async tick(): Promise<void> {
    if (this.polling || this.sending || this.stopped) return;
    this.polling = true;
    try {
      const agent = await this.target();
      if (!agent) return;
      const epoch = this.epoch;
      const text = await this.snapshot(agent);
      const current = await this.target();
      if (
        epoch !== this.epoch ||
        !current ||
        !sameIdentity(agent, current) ||
        current.agent_status !== agent.agent_status ||
        current.state_change_seq !== agent.state_change_seq
      )
        return;
      this.show(current, text);
      this.lastError = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : "read failed";
      if (!this.stopped && message !== this.lastError)
        this.print(`⚠️ Console Agent: ${message}`);
      this.lastError = message;
    } finally {
      this.polling = false;
    }
  }

  async send(
    text: string,
    submit?: (agent: AgentRecord, text: string) => Promise<void>,
  ): Promise<void> {
    if (!text.trim() || text.length > 12000 || text.includes("\u0000"))
      throw new Error("invalid or empty prompt");
    if (this.sending)
      throw new Error("an answer is being sent; wait before replying again");
    this.sending = true;
    try {
      const agent = await this.target();
      if (!agent) throw new Error("select an Agent with agent use <pane>");
      const epoch = this.epoch;
      if (agent.agent_status === "blocked") {
        const output = await this.snapshot(agent);
        const current = await this.target();
        if (
          epoch !== this.epoch ||
          !current ||
          !sameIdentity(agent, current) ||
          current.agent_status !== "blocked" ||
          current.state_change_seq !== agent.state_change_seq
        )
          throw new Error("question is no longer current; answer was not sent");
        const question = JSON.stringify([agent.state_change_seq, output]);
        if (
          !output ||
          this.shown?.status !== "blocked" ||
          this.shown.text !== output ||
          this.shown.seq !== agent.state_change_seq
        ) {
          this.show(agent, output);
          throw new Error(
            "question changed or not yet shown; read it and answer again",
          );
        }
        if (this.consumedQuestion === question)
          throw new Error("answer already sent; waiting for Agent to continue");
        // Uncertain socket delivery must not blindly replay an approval.
        this.consumedQuestion = question;
        await this.herdr.sendAgent(agent.pane_id, text, { retries: 0 });
      } else {
        if (!["idle", "done"].includes(agent.agent_status))
          throw new Error(
            `Agent is ${agent.agent_status}; control commands remain available`,
          );
        if (submit) await submit(agent, text);
        else await this.herdr.promptAgent(agent.pane_id, text);
      }
      this.print(
        `📨 Sent to ${agentLabel(agent)} · ${agent.workspace_id} · ${agent.pane_id}`,
      );
    } finally {
      this.sending = false;
    }
    await this.tick();
  }
}

function sameIdentity(a: AgentRecord, b: AgentRecord): boolean {
  return (
    a.pane_id === b.pane_id &&
    a.workspace_id === b.workspace_id &&
    a.terminal_id === b.terminal_id &&
    a.agent === b.agent &&
    sameAgentSession(a.agent_session, b.agent_session)
  );
}
