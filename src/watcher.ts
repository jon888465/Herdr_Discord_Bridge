import { EventEmitter } from "node:events";
import type { AgentRecord, AgentStatus } from "./types.js";
import { HerdrClient } from "./herdr.js";

export interface AgentTransition {
  agent: AgentRecord;
  from: AgentStatus;
  to: AgentStatus;
}

export interface AgentRemoved {
  terminalId: string;
  lastAgent: AgentRecord;
}

export class AgentWatcher extends EventEmitter {
  private previous = new Map<string, AgentRecord>();
  private timer: NodeJS.Timeout | null = null;
  private primed = false;
  private polling = false;

  constructor(
    private readonly herdr: HerdrClient,
    private readonly intervalMs: number,
  ) {
    super();
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const agents = await this.herdr.listAgents();
      const current = new Map(
        agents.map((agent) => [agent.terminal_id, agent]),
      );
      if (this.primed) {
        for (const [terminalId, agent] of current) {
          const old = this.previous.get(terminalId);
          if (old && old.agent_status !== agent.agent_status) {
            this.emit("transition", {
              agent,
              from: old.agent_status,
              to: agent.agent_status,
            } satisfies AgentTransition);
          }
        }
        for (const [terminalId, lastAgent] of this.previous) {
          if (!current.has(terminalId))
            this.emit("removed", {
              terminalId,
              lastAgent,
            } satisfies AgentRemoved);
        }
      }
      this.previous = current;
      this.primed = true;
    } catch (error) {
      // A socket outage is transient. The next bounded interval retries while
      // Herdr continues running independently of this plugin.
      this.emit("error", error);
    } finally {
      this.polling = false;
    }
  }
}
