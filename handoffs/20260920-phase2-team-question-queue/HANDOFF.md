# Phase 2 — OpenCode checkpoint

2026-09-21 merge note: the authorization below is historical; the user has now authorized merging Phase 2 into local main. Current merge verification is recorded in docs/known-issues.md, ISSUE-012. Deployment/restart is still not part of this merge.

Prepared 2026-09-20 UTC. State: checkpoint-only; no OpenCode takeover claimed.
Source: ChatGPT Work/Codex, exact native session ID unavailable. Destination: OpenCode anticipated by user, session unknown. Native transcript unavailable; use user-provided visible conversation, Git source and ISSUE-012. No hidden reasoning or credentials included.

Workspace: `/workspace/scratch/606aee077653/Herdr_Discord_Bridge`.
Branch: `phase2-team-question-queue`, based on local Phase 1 `ffa33b7`.
This checkpoint is included in the Phase 2 implementation commit; inspect actual git log/status for final HEAD. No sub-agents or other local writers were launched. Source stops writing after final delivery; external writers unknown.

User goal: continue Phase 2 after Durable Task Engine; retain dynamic Lead planning, zero Worker, AgentPool lazy start/reuse, ISSUE-014 correlation and console separation. Do not merge main or deploy/restart the user's Bridge. Prior user explicitly approved pushing the two Phase 1 commits. The earlier handoff's statement that Phase 2 is unauthorized is historical and superseded by the current user request.

Phase 1 remote delivery completed this turn through GitHub integration: remote implementation `9337903349753f40793a2722f0934683e628ee33`, remote handoff `23cd8a266b1b723e8b6f33dda3942190621b8917`. Their tree SHAs match local `ed56de0` / `ffa33b7` exactly. Hashes differ because the integration recreated commits. Local origin tracking ref may remain stale; do not force-push either history.

Implementation: question queue persisted in task journal schema v2 (reads v1), explicit task/question replies, immutable identity and state transitions, pending/sending/answered/stale/unknown/cancelled. Reply validates workspace/session/sequence/snapshot, persists intent and uses existing sendAgent with retries=0. Unknown delivery not replayed. Original nonce/transcript turn continues; no second scheduler/prompt. Other same-wave Workers continue; existing wave barrier remains. Cancel waits in-flight answers before releasing; restart invalidates pending answers and retains quarantine. Source Discord context immutable; console uses selected workspace. No click UI or automatic restart resume.

Read AGENTS.md, SPEC.md, CONTEXT.md, docs/known-issues.md ISSUE-012 and docs/team-question-queue.md, then changed source/tests. Relevant files: src/team-task-engine.ts, src/team-task-store.ts, src/team-orchestration.ts, src/team-turn.ts, src/main.ts, src/console.ts, src/discord.ts, test/team-questions.test.ts; existing schema rejection test now uses 999 since v2 is supported.

Verification 2026-09-20: typecheck/build/lint PASS (43 TS files). Targeted 79/79, including 16 new question tests. Original npm test blocked by Unix socket EPERM and waiting instance-lock child; interrupted exit 130, no total. Bounded full compiled suite 128 total: 122 pass, 5 fail, 1 cancelled/15s timeout. Failures: 2 Herdr socket, 3 instance-lock; timeout: killed-owner fixture. Not a passing full gate or live evidence. Logs in /tmp/phase2-targeted.log, /tmp/phase2-full.log and /tmp/phase2-full-bounded-final.log are transient; ISSUE-012 records durable results.

Next action: inspect current branch/log/status and remote refs, preserve any destination edits; wait for source's final response before sole-writer takeover. Re-run npm test in an IPC-capable environment. Review code and execute live acceptance in docs/team-question-queue.md only after deployment/session-control authorization. Record real CLI versions, IDs, thread routing, duplicate answers, response loss, cancel/restart and dynamic planning outcomes. Do not infer live acceptance from fixtures. Update ISSUE-012, SPEC and CONTEXT if findings change behavior.

Limits: no exact provider quota/reset available (user previously reported low usage); this packet preserves work, not provider quota/model memory. Missing session identity rejects replies; identical snapshot without a new sequence cannot prove a new question. Herdr compare-and-send is not atomic; external pane manipulation can race validation. No multi-bot state writer lock or journal compaction/retention. At most 128 historical questions, original turn timeout includes human waiting. No durable Discord delivery retry.

Receiving receipt: pending; no receiving agent identity, version, writer ownership or live result verified. After acceptance, record those and the actual destination HEAD separately, preserving this source checkpoint.
