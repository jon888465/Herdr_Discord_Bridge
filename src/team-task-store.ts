import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRecord } from "./types.js";
import type {
  AssignmentPlan,
  AssignmentState,
  TeamTaskInput,
} from "./team-orchestration.js";

export type TaskState =
  | "planning"
  | "running"
  | "blocked"
  | "cancelling"
  | "synthesizing"
  | "completed"
  | "failed"
  | "cancelled";
export const terminalTask = (state: TaskState): boolean =>
  ["completed", "failed", "cancelled"].includes(state);
const transitions: Record<TaskState, TaskState[]> = {
  planning: ["running", "blocked", "synthesizing", "cancelling", "failed"],
  running: ["planning", "blocked", "synthesizing", "cancelling", "failed"],
  blocked: ["planning", "running", "synthesizing", "cancelling", "failed"],
  synthesizing: ["completed", "blocked", "failed", "cancelling"],
  cancelling: ["cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};
export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (from !== to && !transitions[from]?.includes(to))
    throw new Error(`invalid task transition ${from} -> ${to}`);
}
export interface DurableAssignment {
  plan: AssignmentPlan["assignments"][number];
  state: AssignmentState;
  agent?: AgentRecord;
  continuity?: string;
  report?: string;
  blocker?: string;
  createdAt: string;
  updatedAt: string;
}
export interface TaskTurn {
  agent: AgentRecord;
  phase: "planning" | "assignment" | "synthesis";
  assignmentId?: string;
  state: "dispatched" | "blocked" | "uncertain";
  cancelAttempted?: boolean;
  recovered?: boolean;
}
export interface TeamQuestion {
  id: string;
  agent: AgentRecord;
  phase: TaskTurn["phase"];
  assignmentId?: string;
  snapshot: string;
  fingerprint: string;
  createdAt: string;
  expiresAt: string;
  state: "pending" | "sending" | "answered" | "stale" | "unknown" | "cancelled";
}
export interface DurableTeamTask {
  questions?: TeamQuestion[];
  origin?: TeamTaskInput["origin"];
  taskId: string;
  workspaceId: string;
  lead: AgentRecord;
  originalPrompt: string;
  roster: AgentRecord[];
  assignments: DurableAssignment[];
  turns: TaskTurn[];
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  synthesis?: string;
  detail?: string;
  recovery?: {
    status: "unknown" | "recoverable";
    reason: string;
    observations: string[];
  };
}
export interface TaskJournalEvent {
  sequence: number;
  at: string;
  type: string;
  // Each event is a complete after-image: replay is deterministic, including reports.
  task: DurableTeamTask;
}
interface Journal {
  schemaVersion: 1 | 2;
  events: TaskJournalEvent[];
}

/** One atomically replaced, fsynced journal per task; no separately committed snapshot. */
export class TeamTaskStore {
  private journals = new Map<string, Journal>();
  private poisoned = false;
  constructor(private readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const name of fs
      .readdirSync(directory)
      .filter((n) => n.endsWith(".json"))) {
      const journal = JSON.parse(
        fs.readFileSync(path.join(directory, name), "utf8"),
      ) as Journal;
      if (
        ![1, 2].includes(journal.schemaVersion) ||
        !Array.isArray(journal.events) ||
        !journal.events.length
      )
        throw new Error(`unsupported or invalid task journal: ${name}`);
      let previous: DurableTeamTask | undefined;
      for (const [index, event] of journal.events.entries()) {
        if (
          event.sequence !== index + 1 ||
          typeof event.type !== "string" ||
          !event.type ||
          !validDate(event.at)
        )
          throw new Error(`invalid task journal event: ${name}`);
        validateTask(event.task);
        if (name !== `${event.task.taskId}.json`)
          throw new Error("task journal identity mismatch");
        if (previous) validateUpdate(previous, event.task);
        else if (event.task.state !== "planning")
          throw new Error("task journal must start in planning");
        previous = event.task;
      }
      this.journals.set(previous!.taskId, journal);
    }
  }
  list(workspaceId?: string): DurableTeamTask[] {
    return [...this.journals.values()]
      .map((j) => structuredClone(j.events.at(-1)!.task))
      .filter((t) => !workspaceId || t.workspaceId === workspaceId);
  }
  get(id: string): DurableTeamTask {
    const task = this.journals.get(id)?.events.at(-1)?.task;
    if (!task) throw new Error("Team Task not found");
    return structuredClone(task);
  }
  events(id: string): TaskJournalEvent[] {
    this.get(id);
    return structuredClone(this.journals.get(id)!.events);
  }
  create(input: TeamTaskInput): DurableTeamTask {
    if (this.journals.has(input.taskId)) throw new Error("duplicate task ID");
    const now = new Date().toISOString();
    const task: DurableTeamTask = {
      taskId: input.taskId,
      ...(input.origin ? { origin: structuredClone(input.origin) } : {}),
      workspaceId: input.lead.workspace_id,
      lead: structuredClone(input.lead),
      originalPrompt: input.prompt,
      roster: structuredClone(input.workers),
      assignments: [],
      turns: [],
      state: "planning",
      createdAt: now,
      updatedAt: now,
    };
    this.write(task, "task_created");
    return this.get(task.taskId);
  }
  update(
    id: string,
    type: string,
    change: (task: DurableTeamTask) => void,
  ): DurableTeamTask {
    const task = this.get(id);
    change(task);
    task.updatedAt = new Date().toISOString();
    if (terminalTask(task.state)) task.finishedAt ??= task.updatedAt;
    this.write(task, type);
    return this.get(id);
  }
  private write(task: DurableTeamTask, type: string): void {
    if (this.poisoned)
      throw new Error(
        "task persistence failed; restart and inspect journals before dispatch",
      );
    validateTask(task);
    const old = this.journals.get(task.taskId);
    if (old) validateUpdate(old.events.at(-1)!.task, task);
    const journal: Journal = {
      schemaVersion: 2,
      events: [
        ...(old?.events ?? []),
        {
          sequence: (old?.events.length ?? 0) + 1,
          at: task.updatedAt,
          type,
          task: structuredClone(task),
        },
      ],
    };
    const file = path.join(this.directory, `${task.taskId}.json`);
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(tmp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(journal) + "\n");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
      if (process.platform !== "win32") {
        const dir = fs.openSync(this.directory, "r");
        try {
          fs.fsyncSync(dir);
        } finally {
          fs.closeSync(dir);
        }
      }
      this.journals.set(task.taskId, journal);
    } catch (error) {
      this.poisoned = true;
      throw error;
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }
}
function validDate(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function validateAgent(a: AgentRecord): void {
  if (
    !a ||
    [a.pane_id, a.terminal_id, a.workspace_id].some(
      (v) => typeof v !== "string" || !v,
    )
  )
    throw new Error("invalid durable Agent identity");
}
function validateTask(t: DurableTeamTask): void {
  if (
    !t ||
    typeof t.taskId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(t.taskId) ||
    !Object.hasOwn(transitions, t.state) ||
    typeof t.originalPrompt !== "string" ||
    !validDate(t.createdAt) ||
    !validDate(t.updatedAt) ||
    !Array.isArray(t.roster) ||
    !Array.isArray(t.assignments) ||
    !Array.isArray(t.turns)
  )
    throw new Error("invalid durable task");
  validateAgent(t.lead);
  for (const a of [t.lead, ...t.roster]) {
    validateAgent(a);
    if (a.workspace_id !== t.workspaceId)
      throw new Error("durable task workspace mismatch");
  }
  const ids = new Set<string>();
  for (const a of t.assignments) {
    if (
      !a.plan ||
      typeof a.plan.id !== "string" ||
      !a.plan.id ||
      ids.has(a.plan.id) ||
      typeof a.plan.instruction !== "string" ||
      !t.roster.some((r) => r.pane_id === a.plan.workerPaneId) ||
      ![
        "pending",
        "assigned",
        "working",
        "blocked",
        "done",
        "failed",
        "cancelled",
      ].includes(a.state) ||
      !validDate(a.createdAt) ||
      !validDate(a.updatedAt)
    )
      throw new Error("invalid durable assignment");
    ids.add(a.plan.id);
    if (a.agent) {
      validateAgent(a.agent);
      if (a.agent.workspace_id !== t.workspaceId)
        throw new Error("assignment workspace mismatch");
    }
  }
  for (const turn of t.turns) {
    validateAgent(turn.agent);
    if (
      turn.agent.workspace_id !== t.workspaceId ||
      !["planning", "assignment", "synthesis"].includes(turn.phase) ||
      !["dispatched", "blocked", "uncertain"].includes(turn.state) ||
      (turn.phase === "assignment" && !ids.has(turn.assignmentId!))
    )
      throw new Error("invalid durable turn");
  }
  const questions = new Set<string>();
  if (t.questions !== undefined && !Array.isArray(t.questions))
    throw new Error("invalid question queue");
  for (const q of t.questions ?? []) {
    validateAgent(q.agent);
    if (
      !q.id ||
      questions.has(q.id) ||
      q.agent.workspace_id !== t.workspaceId ||
      !["planning", "assignment", "synthesis"].includes(q.phase) ||
      (q.phase === "assignment" && !ids.has(q.assignmentId!)) ||
      typeof q.snapshot !== "string" ||
      q.snapshot.length > 6000 ||
      typeof q.fingerprint !== "string" ||
      !validDate(q.createdAt) ||
      !validDate(q.expiresAt) ||
      ![
        "pending",
        "sending",
        "answered",
        "stale",
        "unknown",
        "cancelled",
      ].includes(q.state)
    )
      throw new Error("invalid durable question");
    questions.add(q.id);
  }
  if (terminalTask(t.state) && t.turns.length)
    throw new Error("terminal task still owns unsettled turns");
}
function validateUpdate(old: DurableTeamTask, next: DurableTeamTask): void {
  assertTaskTransition(old.state, next.state);
  for (const key of [
    "taskId",
    "origin",
    "workspaceId",
    "lead",
    "originalPrompt",
    "roster",
    "createdAt",
  ] as const)
    if (JSON.stringify(old[key]) !== JSON.stringify(next[key]))
      throw new Error(`immutable task field: ${key}`);
  for (const q of old.questions ?? []) {
    const nextQuestion = next.questions?.find((v) => v.id === q.id);
    if (!nextQuestion) throw new Error("question history removed");
    for (const field of [
      "agent",
      "phase",
      "assignmentId",
      "snapshot",
      "fingerprint",
      "createdAt",
      "expiresAt",
    ] as const)
      if (JSON.stringify(q[field]) !== JSON.stringify(nextQuestion[field]))
        throw new Error("question identity changed");
    const allowed = {
      pending: ["sending", "stale", "unknown", "cancelled"],
      sending: ["answered", "unknown", "cancelled"],
      answered: [],
      stale: [],
      unknown: ["cancelled"],
      cancelled: [],
    };
    if (
      q.state !== nextQuestion.state &&
      !(allowed[q.state] as string[]).includes(nextQuestion.state)
    )
      throw new Error("invalid question transition");
  }
  for (const a of old.assignments) {
    const b = next.assignments.find((v) => v.plan.id === a.plan.id);
    if (!b || JSON.stringify(a.plan) !== JSON.stringify(b.plan))
      throw new Error("assignment plan changed");
    const allowed: Record<AssignmentState, AssignmentState[]> = {
      pending: ["assigned", "failed", "cancelled"],
      assigned: ["working", "blocked", "failed", "cancelled"],
      working: ["done", "blocked", "failed", "cancelled"],
      blocked: ["working", "done", "failed", "cancelled"],
      done: [],
      failed: [],
      cancelled: [],
    };
    if (a.state !== b.state && !allowed[a.state].includes(b.state))
      throw new Error(`invalid assignment transition ${a.state} -> ${b.state}`);
  }
}
