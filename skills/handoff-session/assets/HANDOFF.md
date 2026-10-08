# Task handoff

Replace the bracketed fields with evidence or `unknown`/`not applicable`.
Keep this packet concise and free of credentials. Preserve dated source facts
when adding a receiving receipt; do not rewrite them as current observations.

## Identity and ownership

- Handoff ID: [unique identifier]
- Prepared at: [ISO timestamp with timezone]
- State: [checkpoint-only / ready / accepted / blocked]
- Source harness/version and session ID/title: [exact identity, unknown if absent]
- Source workspace and repository: [absolute path; no credential-bearing URL]
- Source branch / HEAD: [values]
- Destination harness/session/workspace: [values or not selected]
- Source stopped writing at / evidence: [time and evidence or unknown]
- Other writers/background jobs and owners: [process/task identifiers and status]
- Transfer scope: [files/task owned by recipient; exclusions]
- Limit signal: [quota/rate/context; provider; value/unit; reset; observed at; evidence]

## Goal and constraints

- User's requested outcome and acceptance criteria: [concrete requirements]
- Current instructions and relevant spec: [paths]
- Authorization already granted and actions still requiring approval: [evidence]
- Pending user questions/answers: [preserve exact consequential decisions]

## Recovery evidence

- Native session or local export: [path/ID, format, version, modification time]
- History coverage and missing portions: [ranges/compaction/truncation]
- Relevant design, issue and task documents: [paths]
- Decisions and brief rationale: [decision, public evidence, implications]
- Failed/abandoned approaches: [attempt, observed failure, why not repeat]

## Current work

- Completed and verified: [behavior/file and evidence]
- Attempted or claimed, not verified: [separate from completion]
- Staged/unstaged changes and relevant untracked files: [paths and purpose]
- Other agents' or user's changes to preserve: [paths/scope]
- Worktree/machine differences and needed artifacts: [gaps, not assumed copied]
- Active commands/jobs: [status, output location, whether still writing]
- Build / running process / deployed version: [separate states]

## Verification and continuation

- Checks: [date, command, cwd/HEAD, result, evidence path]
- Failures and unresolved issues: [identifiers, symptoms, known vs suspected cause]
- Not yet verified: [explicit gaps; distinguish automated and live acceptance]
- First next action: [one executable step and expected result]
- Remaining ordered work: [steps, dependencies, completion conditions]

## Receiving receipt

- Accepted/blocked at and destination session: [timestamp and identity]
- Verified workspace / HEAD / current diffs: [observations]
- Reconciled discrepancies and retained uncertainty: [details]
- Writer ownership evidence: [source paused/stopped; background jobs accounted for]
- Accepted scope / first action / subsequent result: [details]
