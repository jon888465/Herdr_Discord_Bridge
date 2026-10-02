import { sameAgentSession } from "./response-stream.js";
import type { AgentRecord } from "./types.js";
import {
  baselineFingerprint,
  type CodingTreeSnapshot,
  type CodingVersion,
} from "./coding-version.js";

export const CODING_ROLES = [
  "diagnose",
  "implement",
  "review",
  "verify",
] as const;
export type CodingRole = (typeof CODING_ROLES)[number];
export type CodingAccess = "read" | "write";
export type CodingStage =
  "diagnose" | "implement" | "review" | "verify" | "ready-to-integrate";
export type ReviewVerdict = "pass" | "changes_requested" | "inconclusive";

export interface AssignmentCoding {
  role: CodingRole;
  access: CodingAccess;
  writeScope: string[];
  artifactRefs: string[];
  findingRefs: string[];
}

export interface CodingFinding {
  id: string;
  summary: string;
  sourceAssignmentId: string;
  artifactId: string;
  versionFingerprint: string;
  status: "open" | "resolved";
  resolvedByAssignmentId?: string;
}

export interface CodingArtifactRecord {
  id: string;
  assignmentId: string;
  role: CodingRole;
  versionFingerprint: string;
  mode: CodingVersion["mode"];
  baseSha: string;
  headSha: string;
  stagedDiffSha256: string;
  unstagedDiffSha256: string;
  deliveryPaths: string[];
  untracked: CodingVersion["untracked"];
  authorPaneId?: string;
  authorSession?: { kind: string; value: string };
  reviewerPaneId?: string;
  reviewerSession?: { kind: string; value: string };
  independentReview?: boolean;
  verdict?: ReviewVerdict;
  reportedVerdict?: ReviewVerdict;
  findingIds: string[];
  commands: Array<{ command: string; exitCode: number }>;
  verificationPassed?: boolean;
  evidence: "recorded" | "missing";
  startVersionFingerprint?: string;
  endVersionFingerprint?: string;
  driftReason?: string;
}

export interface CodingTaskState {
  stage: CodingStage;
  repository: string;
  baseSha: string;
  baselineFingerprint: string;
  baseline: CodingTreeSnapshot;
  versionFingerprint?: string;
  headSha?: string;
  artifacts: CodingArtifactRecord[];
  findings: CodingFinding[];
  acceptance?: { ok: boolean; reasons: string[]; versionFingerprint: string };
}

export interface CodingResult {
  kind: CodingRole;
  verdict?: ReviewVerdict;
  findings: Array<{ id: string; summary: string }>;
  commands: Array<{ command: string; exitCode: number }>;
  files: string[];
}

export function initialCodingState(
  baseline: CodingTreeSnapshot,
): CodingTaskState {
  return {
    stage: "diagnose",
    repository: baseline.repository,
    baseSha: baseline.headSha,
    baselineFingerprint: baselineFingerprint(baseline),
    baseline,
    artifacts: [],
    findings: [],
  };
}

export function sessionIdentity(
  agent: AgentRecord,
): { kind: string; value: string } | undefined {
  const session = agent.agent_session as
    { kind?: unknown; value?: unknown } | undefined;
  if (
    !session ||
    (session.kind !== "id" && session.kind !== "path") ||
    typeof session.value !== "string" ||
    !session.value
  )
    return undefined;
  return { kind: session.kind, value: session.value };
}

export function assertIndependentReview(
  authors: Array<{
    paneId?: string;
    session?: { kind: string; value: string };
  }>,
  reviewer: AgentRecord,
): { kind: string; value: string } {
  if (!authors.length)
    throw new Error("coding review has no implementation artifact");
  const reviewerSession = sessionIdentity(reviewer);
  if (!reviewerSession)
    throw new Error("unknown reviewer identity is not an independent review");
  for (const author of authors) {
    if (!author.session)
      throw new Error(
        "unknown author identity cannot establish an independent review",
      );
    if (
      author.paneId === reviewer.pane_id ||
      sameAgentSession(author.session, reviewer.agent_session)
    )
      throw new Error("same-session review is not an independent review");
  }
  return reviewerSession;
}

function validRelative(scope: string): boolean {
  return (
    !!scope &&
    scope.length <= 240 &&
    !scope.startsWith("/") &&
    !pathHasEscape(scope)
  );
}

function pathHasEscape(scope: string): boolean {
  return (
    scope.includes("\\") ||
    scope.includes("\0") ||
    scope.split("/").includes("..") ||
    pathIsAbsolute(scope)
  );
}

function pathIsAbsolute(scope: string): boolean {
  return scope.startsWith("/") || /^[A-Za-z]:/.test(scope);
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    value.some((item) => typeof item !== "string" || !item || item.length > 200)
  )
    throw new Error(`invalid coding ${label}`);
  return value.map(String);
}

export function parseAssignmentCoding(
  item: Record<string, unknown>,
  enabled: boolean,
): AssignmentCoding | undefined {
  const present = [
    "role",
    "access",
    "writeScope",
    "artifactRefs",
    "findingRefs",
  ].some((key) => item[key] !== undefined);
  if (!enabled || !present) return undefined;
  const role = item.role;
  const access = item.access;
  if (
    !CODING_ROLES.includes(role as CodingRole) ||
    (access !== "read" && access !== "write")
  )
    throw new Error("coding assignment has an invalid role or access");
  const writeScope = stringList(item.writeScope, "writeScope");
  for (const scope of writeScope)
    if (!validRelative(scope))
      throw new Error("coding write scope must stay inside the repository");
  const coding: AssignmentCoding = {
    role: role as CodingRole,
    access,
    writeScope,
    artifactRefs: stringList(item.artifactRefs, "artifactRefs"),
    findingRefs: stringList(item.findingRefs, "findingRefs"),
  };
  validateAssignmentCoding(coding);
  return coding;
}

export function validateAssignmentCoding(coding: AssignmentCoding): void {
  const readOnly = coding.role !== "implement";
  if (readOnly && coding.access !== "read")
    throw new Error(`${coding.role} assignments are read-only in coding v1`);
  if (coding.role === "implement" && coding.access !== "write")
    throw new Error("implement assignments are the single writer in coding v1");
  if (coding.access === "write" && coding.writeScope.length === 0)
    throw new Error("write access requires a write scope");
  if (coding.access === "read" && coding.writeScope.length !== 0)
    throw new Error(
      "read-only coding assignments cannot declare a write scope",
    );
}

export function validateCodingRound(
  assignments: Array<{
    id: string;
    workerPaneId: string;
    dependsOn?: string[];
    coding?: AssignmentCoding;
  }>,
  prior: Array<{ workerPaneId: string; coding?: AssignmentCoding }>,
  findingIds: string[],
  artifactIds: string[],
): void {
  const writers = new Set(
    [...prior, ...assignments]
      .filter((item) => item.coding?.access === "write")
      .map((item) => item.workerPaneId),
  );
  if (writers.size > 1) throw new Error("coding v1 allows only one writer");
  const writer = assignments.find((item) => item.coding?.access === "write");
  for (const assignment of assignments) {
    if (!assignment.coding)
      throw new Error(
        `Assignment ${assignment.id} is missing coding role and access`,
      );
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(assignment.id))
      throw new Error("coding assignment IDs must be URL-safe");
    for (const ref of assignment.coding.findingRefs)
      if (!findingIds.includes(ref))
        throw new Error(
          `Assignment ${assignment.id} references unknown finding ${ref}`,
        );
    for (const ref of assignment.coding.artifactRefs)
      if (!artifactIds.includes(ref))
        throw new Error(
          `Assignment ${assignment.id} references unknown artifact ${ref}`,
        );
    if (
      writer &&
      assignment.id !== writer.id &&
      !(assignment.dependsOn ?? []).includes(writer.id)
    )
      throw new Error(
        "read-only coding assignments in a writer round must depend on that writer",
      );
  }
}

export function codingPlanningAddendum(): string {
  return [
    "This team ask explicitly selected the local Git coding workflow.",
    "Each assignment also has role (diagnose, implement, review, or verify), access (read or write), writeScope (repository-relative paths; required for write and empty for read), artifactRefs, and findingRefs.",
    "Coding v1 allows one writer. diagnose, review, and verify are read-only. A reviewer must be a different known session from the author; a different pane is not proof. Do not implement, commit, merge, push, or use GitHub.",
    "Write scope is checked against the captured diff after the fact. It is not an operating-system lock and prompt text does not isolate writers.",
    "Return an empty assignments array only to request the acceptance gate. An empty plan does not authorize you to edit the repository. The bridge, not this prompt, decides completion.",
    "Review execution can succeed while its verdict asks for changes. Refer to earlier findings and artifacts by findingRefs and artifactRefs. Dependencies still refer only to this round.",
  ].join("\n");
}

export function codingWorkerAddendum(coding: AssignmentCoding): string {
  return [
    `Coding role: ${coding.role}. Access: ${coding.access}. Write scope: ${coding.writeScope.join(", ") || "(none)"}.`,
    `Artifact refs: ${coding.artifactRefs.join(", ") || "(none)"}. Finding refs: ${coding.findingRefs.join(", ") || "(none)"}.`,
    "Access is a bridge check, not an OS write lock. Do not commit, merge, push, or use GitHub.",
    'End the report with one JSON object. implement: {"codingResult":{"kind":"implement","files":[]}}. review: {"codingResult":{"kind":"review","verdict":"pass|changes_requested|inconclusive","findings":[{"id":"f1","summary":"..."}]}}. verify: {"codingResult":{"kind":"verify","commands":[{"command":"npm test","exitCode":0}]}}. diagnose: {"codingResult":{"kind":"diagnose","findings":[]}}.',
    "Use a new finding id when you can. A raw id that is already stored stays on the original finding; the bridge stores the later one as <assignmentId>:<id>. Later findingRefs must use that stored id.",
    "A changes_requested verdict is a successful review report, not an execution failure. The bridge binds read-only evidence to the start version and checks the tree again at the end. A change during review or verify makes that report inconclusive for both versions. The bridge does not re-run reported test commands.",
  ].join("\n");
}

export function codingSynthesisAddendum(reasons: string[]): string {
  return [
    "This is a local Git coding close. Do not modify files, commit, merge, push, or use GitHub. Empty delegation does not authorize implementation.",
    "The bridge acceptance gate is authoritative. Report its result, the captured version, review, tests, and remaining limits.",
    `Current gate observations: ${JSON.stringify(reasons)}`,
  ].join("\n");
}

function extractObjects(value: string): unknown[] {
  const found: unknown[] = [];
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const char = value[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        try {
          found.push(JSON.parse(value.slice(start, index + 1)));
        } catch {
          /* Keep scanning. A report may contain more than one object. */
        }
        start = index;
        break;
      }
    }
  }
  return found;
}

export function parseCodingResult(report: string): CodingResult | undefined {
  for (const value of extractObjects(report)) {
    if (!value || typeof value !== "object" || !("codingResult" in value))
      continue;
    const raw = (value as { codingResult?: unknown }).codingResult;
    if (!raw || typeof raw !== "object") return undefined;
    const item = raw as Record<string, unknown>;
    if (!CODING_ROLES.includes(item.kind as CodingRole)) return undefined;
    const findings = Array.isArray(item.findings) ? item.findings : [];
    if (
      findings.length > 32 ||
      findings.some(
        (finding) =>
          !finding ||
          typeof finding !== "object" ||
          typeof (finding as { id?: unknown }).id !== "string" ||
          !/^[A-Za-z0-9._:-]{1,80}$/.test((finding as { id: string }).id) ||
          typeof (finding as { summary?: unknown }).summary !== "string",
      )
    )
      return undefined;
    const commands = Array.isArray(item.commands) ? item.commands : [];
    if (
      commands.length > 20 ||
      commands.some(
        (command) =>
          !command ||
          typeof command !== "object" ||
          typeof (command as { command?: unknown }).command !== "string" ||
          !(command as { command: string }).command.trim() ||
          (command as { command: string }).command.length > 500 ||
          !Number.isInteger((command as { exitCode?: unknown }).exitCode),
      )
    )
      return undefined;
    const files = Array.isArray(item.files) ? item.files : [];
    if (files.some((file) => typeof file !== "string")) return undefined;
    let verdict = item.verdict as ReviewVerdict | undefined;
    if (
      verdict !== undefined &&
      !["pass", "changes_requested", "inconclusive"].includes(verdict)
    )
      return undefined;
    const parsedFindings = findings.map((finding) => ({
      id: (finding as { id: string }).id,
      summary: (finding as { summary: string }).summary.slice(0, 500),
    }));
    if (verdict === "pass" && parsedFindings.length) verdict = "inconclusive";
    if (verdict === "changes_requested" && !parsedFindings.length)
      verdict = "inconclusive";
    return {
      kind: item.kind as CodingRole,
      verdict,
      findings: parsedFindings,
      commands: commands.map((command) => ({
        command: (command as { command: string }).command,
        exitCode: (command as { exitCode: number }).exitCode,
      })),
      files: files.map(String),
    };
  }
  return undefined;
}

export function inWriteScope(file: string, scopes: string[]): boolean {
  return scopes.some(
    (scope) =>
      file === scope ||
      file.startsWith(scope.endsWith("/") ? scope : `${scope}/`),
  );
}

export function storedFindingId(
  assignmentId: string,
  rawId: string,
  used: readonly string[],
): string {
  if (!used.includes(rawId)) return rawId;
  let candidate = `${assignmentId}:${rawId}`;
  let suffix = 2;
  while (used.includes(candidate)) {
    candidate = `${assignmentId}:${rawId}:${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function settleReadonlyVersion(input: {
  role: CodingRole;
  startFingerprint?: string;
  endFingerprint: string;
  implementFingerprints: readonly string[];
}): { versionFingerprint: string; driftReason?: string } {
  if (input.role === "implement")
    return { versionFingerprint: input.endFingerprint };
  if (!input.startFingerprint)
    return {
      versionFingerprint: input.endFingerprint,
      driftReason: "read-only assignment has no captured start version",
    };
  if (input.startFingerprint !== input.endFingerprint)
    return {
      versionFingerprint: input.endFingerprint,
      driftReason: "repository changed during the read-only assignment",
    };
  if (
    input.role === "review" &&
    !input.implementFingerprints.includes(input.startFingerprint)
  )
    return {
      versionFingerprint: input.endFingerprint,
      driftReason: "review version does not match an implementation artifact",
    };
  return { versionFingerprint: input.endFingerprint };
}

function stableReview(artifact: CodingArtifactRecord, fingerprint: string) {
  return (
    artifact.role === "review" &&
    artifact.versionFingerprint === fingerprint &&
    artifact.startVersionFingerprint === fingerprint &&
    artifact.endVersionFingerprint === fingerprint &&
    artifact.verdict === "pass" &&
    artifact.independentReview === true &&
    artifact.evidence === "recorded" &&
    !artifact.driftReason
  );
}

function stableVerify(artifact: CodingArtifactRecord, fingerprint: string) {
  return (
    artifact.role === "verify" &&
    artifact.versionFingerprint === fingerprint &&
    artifact.startVersionFingerprint === fingerprint &&
    artifact.endVersionFingerprint === fingerprint &&
    artifact.verificationPassed === true &&
    artifact.evidence === "recorded" &&
    !artifact.driftReason
  );
}

export function acceptanceReasons(
  state: CodingTaskState,
  version: CodingVersion,
  writeScopes: string[],
): string[] {
  const reasons: string[] = [];
  if (version.overflow || state.baseline.overflow)
    reasons.push("version capture exceeded the read limit");
  const outside = version.deliveryPaths.filter(
    (file) => !inWriteScope(file, writeScopes),
  );
  if (outside.length)
    reasons.push(`changes outside the writer scope: ${outside.join(", ")}`);
  for (const artifact of state.artifacts)
    if (
      (artifact.role === "review" || artifact.role === "verify") &&
      artifact.driftReason
    )
      reasons.push(
        `read-only version drifted during ${artifact.assignmentId}: ${artifact.driftReason}`,
      );
  const passing = state.artifacts.filter((artifact) =>
    stableReview(artifact, version.fingerprint),
  );
  if (!passing.length)
    reasons.push("no passing review for the current version");
  if (state.findings.some((finding) => finding.status === "open"))
    reasons.push("unhandled findings");
  const verified = state.artifacts.some((artifact) =>
    stableVerify(artifact, version.fingerprint),
  );
  if (!verified)
    reasons.push("no successful verification for the current version");
  return reasons;
}

export function deriveCodingStage(
  state: CodingTaskState,
  versionFingerprint: string,
): CodingStage {
  const open = state.findings.some((finding) => finding.status === "open");
  const review = state.artifacts
    .filter(
      (artifact) =>
        artifact.role === "review" &&
        artifact.versionFingerprint === versionFingerprint,
    )
    .at(-1);
  const verified = state.artifacts.some((artifact) =>
    stableVerify(artifact, versionFingerprint),
  );
  const passed = Boolean(
    review && stableReview(review, versionFingerprint) && !open,
  );
  if (passed && verified) return "ready-to-integrate";
  if (passed) return "verify";
  if (open || review?.verdict === "changes_requested") return "implement";
  if (state.artifacts.some((artifact) => artifact.role === "implement"))
    return "review";
  return "diagnose";
}

export function applyCodingResult(
  state: CodingTaskState,
  artifact: CodingArtifactRecord,
  result: CodingResult | undefined,
): void {
  if (artifact.driftReason) return;
  if (result?.kind === "review" && result.verdict === "changes_requested") {
    const used = state.findings.map((item) => item.id);
    for (const finding of result.findings) {
      const id = storedFindingId(artifact.assignmentId, finding.id, used);
      used.push(id);
      state.findings.push({
        id,
        summary: finding.summary,
        sourceAssignmentId: artifact.assignmentId,
        artifactId: artifact.id,
        versionFingerprint: artifact.versionFingerprint,
        status: "open",
      });
    }
  }
  if (result?.kind === "review" && result.verdict === "pass") {
    const sameVersion = state.findings.some(
      (finding) =>
        finding.status === "open" &&
        finding.versionFingerprint === artifact.versionFingerprint,
    );
    if (!sameVersion) {
      for (const finding of state.findings) {
        if (finding.status === "open") {
          finding.status = "resolved";
          finding.resolvedByAssignmentId = artifact.assignmentId;
        }
      }
    }
  }
}
