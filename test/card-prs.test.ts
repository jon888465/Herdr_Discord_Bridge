import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CardPullRequestStore } from "../src/card-prs.js";

function file(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "card-prs-")),
    "state",
    "card-prs.json",
  );
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const entry = {
  cardId: "REQ-20261103-one",
  repo: "jon888465/Herdr_Discord_Bridge",
  number: 42,
  url: "https://github.com/jon888465/Herdr_Discord_Bridge/pull/42",
  headSha: SHA,
  origin: { guildId: "g", channelId: "c", threadId: "t" },
};
const T1 = "2026-11-03T08:00:00Z";
const T2 = "2026-11-03T09:00:00Z";

test("a missing file is an empty store and nothing is created until something is recorded", () => {
  const f = file();
  const store = new CardPullRequestStore(f);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.open(), []);
  assert.equal(fs.existsSync(f), false);
});

test("a recorded pull request persists, is open, and the file is private", () => {
  const f = file();
  new CardPullRequestStore(f).record(entry, T1);
  const reopened = new CardPullRequestStore(f);
  assert.deepEqual(reopened.open(), [
    { ...entry, openedAt: T1, state: "OPEN" },
  ]);
  assert.equal(reopened.forCard("REQ-20261103-one")[0].number, 42);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
  }
});

test("the same pull request cannot be recorded twice, and a card has at most one open pull request", () => {
  const f = file();
  const store = new CardPullRequestStore(f);
  store.record(entry, T1);
  const before = fs.readFileSync(f, "utf8");
  store.record(entry, T2);
  assert.equal(fs.readFileSync(f, "utf8"), before);
  assert.throws(
    () => store.record({ ...entry, number: 43 }, T2),
    /already has an open pull request/,
  );
  assert.equal(fs.readFileSync(f, "utf8"), before);
});

test("markEnded closes it for polling, keeps the history, and lets the card open another one", () => {
  const f = file();
  const store = new CardPullRequestStore(f);
  store.record(entry, T1);
  store.markEnded("jon888465/Herdr_Discord_Bridge", 42, "MERGED", T2);
  assert.deepEqual(store.open(), []);
  const [first] = store.list();
  assert.equal(first.state, "MERGED");
  assert.equal(first.endedAt, T2);
  store.record({ ...entry, number: 43 }, "2026-11-03T10:00:00Z");
  assert.deepEqual(
    new CardPullRequestStore(f).list().map((p) => [p.number, p.state]),
    [
      [42, "MERGED"],
      [43, "OPEN"],
    ],
  );
  assert.throws(
    () => store.markEnded("jon888465/Herdr_Discord_Bridge", 99, "CLOSED", T2),
    /unknown pull request/,
  );
  assert.throws(
    () =>
      store.markEnded(
        "jon888465/Herdr_Discord_Bridge",
        43,
        "OPEN" as never,
        T2,
      ),
    /state/,
  );
});

test("markCiReported remembers the head sha whose CI result was reported, once", () => {
  const f = file();
  const store = new CardPullRequestStore(f);
  store.record(entry, T1);
  store.markCiReported("jon888465/Herdr_Discord_Bridge", 42, SHA);
  assert.equal(new CardPullRequestStore(f).open()[0].ciReportedSha, SHA);
  const other = "f".repeat(40);
  store.markCiReported("jon888465/Herdr_Discord_Bridge", 42, other);
  assert.equal(store.open()[0].ciReportedSha, other);
  assert.throws(
    () => store.markCiReported("x/y", 1, SHA),
    /unknown pull request/,
  );
  assert.throws(
    () => store.markCiReported("jon888465/Herdr_Discord_Bridge", 42, "zz"),
    /sha/,
  );
});

test("a new head sha after a push re-opens the CI report", () => {
  const store = new CardPullRequestStore(file());
  store.record(entry, T1);
  store.markCiReported("jon888465/Herdr_Discord_Bridge", 42, SHA);
  store.updateHead("jon888465/Herdr_Discord_Bridge", 42, "e".repeat(40));
  const [current] = store.open();
  assert.equal(current.headSha, "e".repeat(40));
  assert.notEqual(current.ciReportedSha, current.headSha);
});

test("invalid entries are refused and nothing is written", () => {
  const f = file();
  const store = new CardPullRequestStore(f);
  const bad: Array<[string, Partial<typeof entry>]> = [
    ["cardId", { cardId: "../x" }],
    ["repo", { repo: "not a repo" }],
    ["number", { number: 0 }],
    ["number", { number: 1.5 }],
    ["url", { url: "http://example.invalid/pull/1" }],
    ["headSha", { headSha: "zz" }],
  ];
  for (const [field, patch] of bad)
    assert.throws(
      () => store.record({ ...entry, ...patch }, T1),
      new RegExp(field),
      field,
    );
  assert.throws(() => store.record(entry, "yesterday"), /time/);
  assert.equal(fs.existsSync(f), false);
});

test("a corrupt or tampered file is refused instead of being treated as empty", () => {
  const good = { ...entry, openedAt: T1, state: "OPEN" };
  for (const content of [
    "not json",
    JSON.stringify({ version: 2, pullRequests: [] }),
    JSON.stringify({ version: 1, pullRequests: [{ ...good, number: 0 }] }),
    JSON.stringify({ version: 1, pullRequests: [{ ...good, state: "WEIRD" }] }),
    JSON.stringify({ version: 1, pullRequests: [good, good] }),
  ]) {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    assert.throws(
      () => new CardPullRequestStore(f),
      /card-prs/,
      content.slice(0, 60),
    );
  }
});
