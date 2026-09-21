import { sameAgentSession } from "./response-stream.js";
import {
  runTeamTask,
  type OrchestrationEvent,
  type OrchestrationPort,
  type TeamTaskInput,
} from "./team-orchestration.js";
import {
  TeamTaskStore,
  terminalTask,
  type DurableTeamTask,
} from "./team-task-store.js";
import type { AgentRecord } from "./types.js";

type Port = OrchestrationPort & {
  listAgentsWithWorkspaceNames(): Promise<AgentRecord[]>;
  cancelAgent(target: string): Promise<void>;
};
function knownSession(a: AgentRecord): boolean {
  const s = a.agent_session as { kind?: unknown; value?: unknown } | undefined;
  return (
    !!s &&
    typeof s.kind === "string" &&
    !!s.kind &&
    typeof s.value === "string" &&
    !!s.value
  );
}
export function sameTaskSession(a: AgentRecord, b: AgentRecord): boolean {
  return (
    knownSession(a) &&
    knownSession(b) &&
    a.pane_id === b.pane_id &&
    a.terminal_id === b.terminal_id &&
    a.workspace_id === b.workspace_id &&
    a.agent === b.agent &&
    sameAgentSession(a.agent_session, b.agent_session)
  );
}

/** Owns task execution and reservations; the existing scheduler remains the only planner. */
export class TeamTaskEngine {
  private executions = new Map<
    string,
    { controller: AbortController; done: Promise<unknown> }
  >();
  private reservations = new Map<string, Set<string>>();
  private cancellations = new Map<string, Promise<DurableTeamTask>>();
  constructor(
    readonly store: TeamTaskStore,
    private readonly herdr: Port,
    private readonly activeStreams: Set<string>,
    private readonly releaseProfiles: (owner: string) => void = () => {},
    private readonly allowedWorkspaces: string[] = [],
  ) {}
  private authorize(task: DurableTeamTask): void {
    if (
      this.allowedWorkspaces.length &&
      !this.allowedWorkspaces.includes(task.workspaceId)
    )
      throw new Error("task workspace is not authorized");
  }
  private reserve(id: string, agent: AgentRecord, recovering = false): void {
    const owned = this.reservations.get(id) ?? new Set<string>();
    if (owned.has(agent.terminal_id)) return;
    if (this.activeStreams.has(agent.terminal_id))
      throw new Error("Agent is reserved by another task or stream");
    if (!recovering && !["idle", "done"].includes(agent.agent_status))
      throw new Error(`Agent is ${agent.agent_status}`);
    owned.add(agent.terminal_id);
    this.reservations.set(id, owned);
    this.activeStreams.add(agent.terminal_id);
  }
  private release(id: string): void {
    for (const terminal of this.reservations.get(id) ?? [])
      this.activeStreams.delete(terminal);
    this.reservations.delete(id);
    this.releaseProfiles(id);
  }
  owns(agent: AgentRecord): boolean {
    return [...this.reservations.values()].some((r) =>
      r.has(agent.terminal_id),
    );
  }
  run(
    input: TeamTaskInput,
    notify: (event: OrchestrationEvent) => void = () => {},
  ): Promise<DurableTeamTask> {
    if (
      this.allowedWorkspaces.length &&
      !this.allowedWorkspaces.includes(input.lead.workspace_id)
    )
      throw new Error("task workspace is not authorized");
    input = {
      ...input,
      lead: structuredClone(input.lead),
      workers: structuredClone(input.workers),
    };
    this.store.create(input);
    try {
      this.reserve(input.taskId, input.lead);
    } catch (error) {
      this.record({
        type: "task_failed",
        taskId: input.taskId,
        detail: error instanceof Error ? error.message : "reservation failed",
      });
      throw error;
    }
    const controller = new AbortController();
    const workerOwners = new Map<string, string>();
    const execute = async () => {
      try {
        await runTeamTask(
          {
            ...input,
            signal: controller.signal,
            acquireWorker: async (worker) => {
              controller.signal.throwIfAborted();
              const acquired = input.acquireWorker
                ? await input.acquireWorker(worker)
                : { agent: worker, continuity: "unknown" };
              controller.signal.throwIfAborted();
              const agent = acquired.agent;
              if (
                agent.workspace_id !== input.lead.workspace_id ||
                agent.pane_id === input.lead.pane_id
              )
                throw new Error("invalid Worker identity");
              const prior = workerOwners.get(agent.terminal_id);
              if (prior && prior !== worker.pane_id)
                throw new Error(
                  "multiple roster entries refer to the same Worker session",
                );
              this.reserve(input.taskId, agent);
              workerOwners.set(agent.terminal_id, worker.pane_id);
              return acquired;
            },
          },
          this.herdr,
          (event) => {
            controller.signal.throwIfAborted();
            try {
              this.record(event);
            } catch (error) {
              controller.abort(error);
              throw error;
            }
            // Delivery is not part of execution/persistence success.
            try {
              notify(event);
            } catch {
              /* The task remains queryable. */
            }
          },
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          const detail =
            error instanceof Error ? error.message : "task execution failed";
          this.record({ type: "task_failed", taskId: input.taskId, detail });
        } else if (this.store.get(input.taskId).state !== "cancelling") {
          // A persistence failure is fatal to dispatch; surface it, never synthesize success.
          throw error;
        }
      } finally {
        this.executions.delete(input.taskId);
        if (terminalTask(this.store.get(input.taskId).state))
          this.release(input.taskId);
      }
      return this.store.get(input.taskId);
    };
    // Register before the scheduler can dispatch or a second command can cancel.
    const done = Promise.resolve().then(execute);
    this.executions.set(input.taskId, { controller, done });
    return done;
  }
  private record(event: OrchestrationEvent): void {
    this.store.update(event.taskId, event.type, (task) => {
      const assignment = task.assignments.find(
        (a) => a.plan.id === event.assignmentId,
      );
      if (assignment) assignment.updatedAt = new Date().toISOString();
      if (event.type.startsWith("task_") && event.report !== undefined)
        task.synthesis = event.report;
      switch (event.type) {
        case "task_started":
          break;
        case "plan_requested":
          task.state = "planning";
          break;
        case "plan_validated":
          for (const plan of event.plan!.assignments)
            task.assignments.push({
              plan: structuredClone(plan),
              state: "pending",
              createdAt: task.updatedAt,
              updatedAt: task.updatedAt,
            });
          break;
        case "assignment_started":
          task.state = "running";
          assignment!.state = "assigned";
          assignment!.agent = structuredClone(event.agent!);
          assignment!.continuity = event.detail;
          break;
        case "turn_dispatched":
          task.turns.push({
            agent: structuredClone(event.agent!),
            phase: event.phase!,
            assignmentId: event.assignmentId,
            state: "dispatched",
          });
          if (assignment) assignment.state = "working";
          break;
        case "turn_settled": {
          const turn = task.turns.find(
            (t) =>
              t.phase === event.phase && t.assignmentId === event.assignmentId,
          );
          if (event.turnState === "done")
            task.turns = task.turns.filter((t) => t !== turn);
          else if (turn) turn.state = "blocked";
          break;
        }
        case "assignment_completed":
          assignment!.state = "done";
          assignment!.report = event.report;
          break;
        case "assignment_blocked":
          assignment!.state = "blocked";
          assignment!.blocker = event.detail;
          break;
        case "assignment_failed":
          assignment!.state = "failed";
          assignment!.blocker = event.detail;
          for (const turn of task.turns.filter(
            (t) => t.assignmentId === event.assignmentId,
          ))
            turn.state = "uncertain";
          break;
        case "synthesis_started":
          task.state = "synthesizing";
          break;
        case "task_completed":
          task.state = "completed";
          break;
        case "task_blocked":
          task.state = "blocked";
          task.detail = event.detail;
          break;
        case "task_failed":
          task.state = task.turns.length ? "blocked" : "failed";
          task.detail = event.detail;
          if (task.turns.length)
            task.recovery = {
              status: "unknown",
              reason:
                "Unsettled dispatch; inspect before cancelling. No automatic replay.",
              observations: [],
            };
          break;
      }
    });
  }
  /** Restart never resumes an old promise or treats matching idle/done as a report. */
  async reconcile(): Promise<void> {
    let live: AgentRecord[] = [];
    let unavailable = false;
    try {
      live = await this.herdr.listAgentsWithWorkspaceNames();
    } catch {
      unavailable = true;
    }
    for (const old of this.store.list().filter((t) => !terminalTask(t.state))) {
      const permitted =
        !this.allowedWorkspaces.length ||
        this.allowedWorkspaces.includes(old.workspaceId);
      const identities = [
        old.lead,
        ...old.assignments.flatMap((a) => (a.agent ? [a.agent] : [])),
      ];
      const observations = identities.map((a) => {
        const current = live.find(
          (v) => v.pane_id === a.pane_id && v.workspace_id === a.workspace_id,
        );
        return `${a.pane_id}: ${unavailable || !permitted ? "unavailable" : !current ? "missing" : sameTaskSession(a, current) ? `same-session/${current.agent_status}; turn continuity unverified` : "unknown or replaced session"}`;
      });
      this.store.update(old.taskId, "restart_reconciled", (task) => {
        if (task.state !== "cancelling") task.state = "blocked";
        task.recovery = {
          status:
            !unavailable &&
            permitted &&
            identities.every((a) => live.some((v) => sameTaskSession(a, v)))
              ? "recoverable"
              : "unknown",
          reason:
            "Bridge restarted; execution stopped being observed. Inspect/cancel; no automatic redispatch or synthesis.",
          observations,
        };
        for (const turn of task.turns) {
          turn.state = "uncertain";
          turn.recovered = true;
        }
        for (const a of task.assignments)
          if (["assigned", "working"].includes(a.state)) {
            a.state = "blocked";
            a.blocker = "restart: turn continuity unknown";
            a.updatedAt = new Date().toISOString();
          }
      });
      // Quarantine the original terminals until an explicit whole-task cancellation.
      for (const identity of identities)
        this.reserve(old.taskId, identity, true);
    }
  }
  cancel(id: string): Promise<DurableTeamTask> {
    const existing = this.cancellations.get(id);
    if (existing) return existing;
    const operation = this.cancelTask(id).finally(() =>
      this.cancellations.delete(id),
    );
    this.cancellations.set(id, operation);
    return operation;
  }
  private async cancelTask(id: string): Promise<DurableTeamTask> {
    const task = this.store.get(id);
    this.authorize(task);
    if (terminalTask(task.state)) return task;
    this.store.update(id, "cancel_requested", (t) => {
      t.state = "cancelling";
    });
    const execution = this.executions.get(id);
    execution?.controller.abort(new Error("Team Task cancellation requested"));
    // Do not release reservations while a lazy acquisition or dispatch is still in flight.
    await execution?.done;
    const remaining: string[] = [];
    for (const turn of this.store.get(id).turns) {
      try {
        const live = await this.herdr.listAgentsWithWorkspaceNames();
        const current = live.find(
          (a) =>
            a.pane_id === turn.agent.pane_id &&
            a.workspace_id === turn.agent.workspace_id,
        );
        if (
          !current ||
          (knownSession(current) &&
            knownSession(turn.agent) &&
            !sameTaskSession(current, turn.agent))
        ) {
          this.settleCancelledTurn(
            id,
            turn.agent.terminal_id,
            "original session absent/replaced; no signal sent",
          );
          continue;
        }
        if (!sameTaskSession(current, turn.agent)) {
          remaining.push(
            `${turn.agent.pane_id}: session identity unknown; no signal sent`,
          );
          continue;
        }
        if (["idle", "done"].includes(current.agent_status)) {
          this.settleCancelledTurn(
            id,
            turn.agent.terminal_id,
            "already settled; no completion inferred",
          );
          continue;
        }
        if (turn.cancelAttempted) {
          remaining.push(
            `${current.pane_id}: previous cancel unconfirmed; inspect manually`,
          );
          continue;
        }
        if (!["working", "blocked"].includes(current.agent_status)) {
          remaining.push(`${current.pane_id}: state unknown`);
          continue;
        }
        // After restart, same session does not prove the current work is our turn.
        if (turn.recovered) {
          remaining.push(
            `${current.pane_id}: recovered turn ownership unknown; inspect/stop manually`,
          );
          continue;
        }
        this.store.update(id, "cancel_signal_intent", (t) => {
          t.turns.find(
            (v) => v.agent.terminal_id === current.terminal_id,
          )!.cancelAttempted = true;
        });
        await this.herdr.cancelAgent(current.pane_id);
        const stopped = (await this.herdr.listAgentsWithWorkspaceNames()).find(
          (a) =>
            a.pane_id === current.pane_id &&
            a.workspace_id === current.workspace_id,
        );
        if (
          !stopped ||
          (sameTaskSession(stopped, current) &&
            ["idle", "done"].includes(stopped.agent_status))
        )
          this.settleCancelledTurn(id, current.terminal_id, "cancel confirmed");
        else
          remaining.push(
            `${current.pane_id}: cancel sent; stop not yet confirmed`,
          );
      } catch (error) {
        remaining.push(
          `${turn.agent.pane_id}: ${error instanceof Error ? error.message : "cancel failed"}`,
        );
      }
    }
    const result = this.store.update(
      id,
      remaining.length ? "cancel_unconfirmed" : "task_cancelled",
      (t) => {
        t.detail =
          remaining.join("\n") ||
          "All task turns settled; no CLI session was closed.";
        if (!remaining.length && !t.turns.length) {
          t.state = "cancelled";
          for (const a of t.assignments)
            if (!["done", "failed", "cancelled"].includes(a.state)) {
              a.state = "cancelled";
              a.updatedAt = new Date().toISOString();
            }
        }
      },
    );
    if (result.state === "cancelled") this.release(id);
    return result;
  }
  private settleCancelledTurn(
    id: string,
    terminal: string,
    detail: string,
  ): void {
    this.store.update(id, "cancel_turn_settled", (task) => {
      task.turns = task.turns.filter((t) => t.agent.terminal_id !== terminal);
      task.detail = detail;
    });
  }
}
