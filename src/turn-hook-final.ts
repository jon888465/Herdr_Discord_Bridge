import type { HookEventStore } from "./hook-events.js";
import { hookModeFor, type HookTransportMode } from "./hook-status.js";
import type { TeamTurnContext } from "./team-turn.js";

/** Shared Stop lookup for Team tasks and card review/fix turns. */
export function createTurnHookFinal(
  transport: Partial<Record<string, HookTransportMode>> | undefined,
  events: Pick<HookEventStore, "stopSince" | "stopForPane">,
): NonNullable<TeamTurnContext["hookFinal"]> {
  return (agent, since) => {
    if (hookModeFor(transport, agent.agent) !== "auto") return;
    const session = agent.agent_session as
      { kind?: string; value?: string } | undefined;
    const event = session
      ? events.stopSince(session.value, since)
      : events.stopForPane(agent.pane_id, since);
    return event?.message;
  };
}
