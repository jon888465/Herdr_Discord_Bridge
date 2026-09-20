import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DiscordAdapter } from "../src/discord.js";
import { RoutingStore } from "../src/routing.js";
import type { TeamQuestion } from "../src/team-task-store.js";
import type { Interaction, Message, ModalBuilder } from "discord.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "question-ui-"));
  const adapter = new DiscordAdapter(
    {
      enabled: true,
      botToken: "",
      allowedGuildIds: ["g"],
      allowedChannelIds: ["c"],
      allowedUserIds: ["u", "v"],
      messageContent: true,
      commandPrefix: "/herdr",
      requireMention: true,
    },
    new RoutingStore(path.join(dir, "routing.json")),
  );
  Object.defineProperty(adapter["client"], "user", { value: { id: "bot" } });
  const taskId = `task-${randomUUID()}`;
  const question: TeamQuestion = {
    id: `q-${randomUUID()}`,
    agent: {
      terminal_id: "worker",
      workspace_id: "w",
      pane_id: "w:p1",
      tab_id: "tab",
      agent: "codex",
      agent_status: "blocked",
    },
    phase: "assignment",
    assignmentId: "inspect",
    state: "pending",
    snapshot: "Which change should be applied?",
    fingerprint: "fingerprint",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  };
  const cards: Array<{
    content: string;
    components: Array<{
      toJSON: () => { components: Array<{ custom_id?: string }> };
    }>;
    allowedMentions: { parse: string[] };
  }> = [];
  const message = {
    author: { id: "bot" },
    id: "card",
    reply: async (data: (typeof cards)[number]) => {
      cards.push(data);
      return message;
    },
    channel: {
      send: async (data: (typeof cards)[number]) => {
        cards.push(data);
        return message;
      },
    },
  } as unknown as Message;
  const answers: string[] = [],
    actors: string[] = [];
  let beforeAnswer: (() => Promise<void>) | undefined;
  adapter.onTeamQuestion(async (context, task, q, answer) => {
    assert.equal(task, taskId);
    assert.equal(q, question.id);
    assert.deepEqual(
      { ...context, userId: "u" },
      { guildId: "g", channelId: "c", threadId: "t", userId: "u" },
    );
    if (question.state !== "pending")
      throw new Error("question is no longer pending");
    if (answer !== undefined) {
      await beforeAnswer?.();
      actors.push(context.userId);
      answers.push(answer);
      question.state = "answered";
    }
    return question;
  });
  function interaction(
    type: "button" | "modal",
    customId: string,
    userId = "u",
    answer = "Yes  Use A\nPreserve B",
  ) {
    const replies: string[] = [],
      modals: ModalBuilder[] = [];
    const data = {
      customId,
      guildId: "g",
      channelId: "t",
      channel: { id: "t", parentId: "c", isThread: () => true },
      user: { id: userId },
      message,
      deferred: false,
      replied: false,
      isButton: () => type === "button",
      isModalSubmit: () => type === "modal",
      isStringSelectMenu: () => false,
      reply: async (payload: { content: string; ephemeral: boolean }) => {
        assert.equal(payload.ephemeral, true);
        replies.push(payload.content);
        data.replied = true;
      },
      showModal: async (modal: ModalBuilder) => {
        modals.push(modal);
      },
      deferReply: async (payload: { ephemeral: boolean }) => {
        assert.equal(payload.ephemeral, true);
        data.deferred = true;
      },
      editReply: async (payload: { content: string }) => {
        replies.push(payload.content);
      },
      fields: {
        getTextInputValue: (key: string) => {
          assert.equal(key, "answer");
          return answer;
        },
      },
    };
    return {
      data,
      replies,
      modals,
      handle: () =>
        adapter["handleInteraction"](data as unknown as Interaction),
    };
  }
  const open = () => interaction("button", `hdb.tq.${taskId}.${question.id}`);
  return {
    dir,
    adapter,
    taskId,
    question,
    message,
    cards,
    answers,
    actors,
    interaction,
    open,
    beforeAnswer: (hook: () => Promise<void>) => {
      beforeAnswer = hook;
    },
    close: async () => {
      await adapter.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("long question cards have one button after the full snapshot and disable mentions", async (t) => {
  const f = fixture();
  t.after(f.close);
  f.question.snapshot = "@everyone 😀 retained context\n".repeat(140);
  await f.adapter.postTeamQuestion(f.message, f.taskId, f.question, "w");
  assert.ok(f.cards.length > 1);
  assert.ok(f.cards.every((c) => c.content.length < 2000));
  assert.ok(f.cards.slice(0, -1).every((c) => !c.components.length));
  assert.ok(f.cards.every((c) => c.allowedMentions.parse.length === 0));
  assert.equal(
    f.cards.at(-1)?.components[0].toJSON().components[0].custom_id,
    `hdb.tq.${f.taskId}.${f.question.id}`,
  );
  assert.equal(
    f.cards
      .map((c) => c.content)
      .join("")
      .match(/retained context/g)?.length,
    140,
  );
});

for (const state of ["answered", "unknown", "cancelled"] as const)
  test(`historical ${state} cards have no answer button`, async (t) => {
    const f = fixture();
    t.after(f.close);
    f.question.state = state;
    await f.adapter.postTeamQuestion(f.message, f.taskId, f.question, "w");
    assert.equal(f.cards[0].components.length, 0);
  });

test("button opens a blank form, submission uses clicking user and preserves answer whitespace", async (t) => {
  const f = fixture();
  t.after(f.close);
  const button = f.open();
  await button.handle();
  assert.equal(f.answers.length, 0);
  const modal = button.modals[0].toJSON();
  assert.ok(modal.custom_id.length <= 100);
  const answer = f.interaction("modal", modal.custom_id);
  await answer.handle();
  assert.deepEqual(f.answers, ["Yes  Use A\nPreserve B"]);
  assert.deepEqual(f.actors, ["u"]);
  assert.match(answer.replies[0], /delivered/);
  assert.doesNotMatch(answer.replies[0], /Use A/);
});

for (const field of ["user", "guild", "channel", "paused"])
  test(`reject unauthorized ${field} before opening a form or inspecting the question`, async (t) => {
    const f = fixture();
    t.after(f.close);
    f.adapter.onTeamQuestion(async () => {
      assert.fail("must not read question");
    });
    const button = f.open();
    if (field === "user") button.data.user.id = "unknown";
    if (field === "guild") button.data.guildId = "other";
    if (field === "channel") button.data.channel.parentId = "other";
    if (field === "paused") f.adapter.setPaused(true);
    await button.handle();
    assert.equal(button.modals.length, 0);
    assert.ok(button.replies.length);
  });

test("forged card, stale question and missing handler cannot open a form", async (t) => {
  const f = fixture();
  t.after(f.close);
  const forged = f.open();
  forged.data.message = {
    ...f.message,
    author: { id: "other-bot" },
  } as Message;
  await forged.handle();
  assert.equal(forged.modals.length, 0);
  f.question.state = "unknown";
  const stale = f.open();
  await stale.handle();
  assert.equal(stale.modals.length, 0);
  f.adapter["questionHandler"] = null;
  const missing = f.open();
  await missing.handle();
  assert.equal(missing.modals.length, 0);
});

test("form is bound to user and thread; unauthorized attempts cannot consume the owner's form", async (t) => {
  const f = fixture();
  t.after(f.close);
  const button = f.open();
  await button.handle();
  const id = button.modals[0].toJSON().custom_id;
  const other = f.interaction("modal", id, "v");
  await other.handle();
  assert.match(other.replies[0], /another user/);
  const moved = f.interaction("modal", id);
  moved.data.channel.id = "another-thread";
  moved.data.channelId = "another-thread";
  await moved.handle();
  assert.match(moved.replies[0], /another user/);
  assert.deepEqual(f.answers, []);
  await f.interaction("modal", id).handle();
  assert.equal(f.answers.length, 1);
});

test("concurrent duplicate submission is consumed before delivery and cannot resend", async (t) => {
  const f = fixture();
  t.after(f.close);
  const button = f.open();
  await button.handle();
  const id = button.modals[0].toJSON().custom_id;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.beforeAnswer(() => waiting);
  const first = f.interaction("modal", id).handle();
  const duplicate = f.interaction("modal", id);
  await duplicate.handle();
  assert.match(duplicate.replies[0], /already used/);
  release();
  await first;
  assert.equal(f.answers.length, 1);
});

test("failed or uncertain reply cannot reuse the same form", async (t) => {
  const f = fixture();
  t.after(f.close);
  const button = f.open();
  await button.handle();
  const id = button.modals[0].toJSON().custom_id;
  let attempts = 0;
  f.beforeAnswer(async () => {
    attempts++;
    throw new Error("delivery unknown");
  });
  const first = f.interaction("modal", id);
  await first.handle();
  assert.match(first.replies[0], /unknown/);
  await f.interaction("modal", id).handle();
  assert.equal(attempts, 1);
});

for (const reason of [
  "expired",
  "restart",
  "paused",
  "answered",
  "cancelled",
  "empty",
  "too-long",
])
  test(`reject ${reason} form without sending to Agent`, async (t) => {
    const f = fixture();
    t.after(f.close);
    const button = f.open();
    await button.handle();
    const id = button.modals[0].toJSON().custom_id;
    if (reason === "expired") f.adapter["answerTickets"].get(id)!.expiresAt = 0;
    if (reason === "restart") f.adapter["answerTickets"].clear();
    if (reason === "paused") f.adapter.setPaused(true);
    if (reason === "answered" || reason === "cancelled")
      f.question.state = reason;
    const form = f.interaction(
      "modal",
      id,
      "u",
      reason === "empty"
        ? "   "
        : reason === "too-long"
          ? "x".repeat(4001)
          : "answer",
    );
    await form.handle();
    assert.deepEqual(f.answers, []);
    assert.ok(form.replies.length);
  });

test("failure showing a modal discards its ticket", async (t) => {
  const f = fixture();
  t.after(f.close);
  const button = f.open();
  button.data.showModal = async () => {
    throw new Error("Discord unavailable");
  };
  await button.handle();
  assert.equal(f.adapter["answerTickets"].size, 0);
});

test("Discord acknowledgement failure after delivery does not claim the Agent rejected the answer", async (t) => {
  const f = fixture();
  t.after(f.close);
  const button = f.open();
  await button.handle();
  const id = button.modals[0].toJSON().custom_id;
  const form = f.interaction("modal", id);
  let count = 0;
  form.data.editReply = async (payload) => {
    if (++count === 1) throw new Error("Discord edit failed");
    form.replies.push(payload.content);
  };
  await form.handle();
  assert.equal(f.answers.length, 1);
  assert.match(form.replies[0], /was delivered/);
  await f.interaction("modal", id).handle();
  assert.equal(f.answers.length, 1);
});
