import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeCommits, isGitHubNoreply, obfuscateEmail } from "../src/core.js";
import { parseLog } from "../src/git.js";

const commit = (o) => ({
  sha: "0".repeat(40),
  authorName: "",
  authorEmail: "",
  committerName: "",
  committerEmail: "",
  message: "",
  ...o,
});

test("noreply detection", () => {
  assert.ok(isGitHubNoreply("123+user@users.noreply.github.com"));
  assert.ok(isGitHubNoreply("noreply@github.com"));
  assert.ok(!isGitHubNoreply("jane@acme.com"));
});

test("email masking", () => {
  assert.equal(obfuscateEmail("jane@acme.com"), "j***@acme.com");
  assert.equal(obfuscateEmail("jonathan@acme.com"), "j******@acme.com");
  assert.equal(
    obfuscateEmail("1+u@users.noreply.github.com"),
    "1+u@users.noreply.github.com"
  );
});

test("personal email is high risk", () => {
  const r = analyzeCommits([
    commit({ authorName: "Jane Dev", authorEmail: "jane@acme.com" }),
  ]);
  assert.equal(r.highCount, 1);
  assert.equal(r.identities[0].types.includes("email"), true);
});

test("noreply-only author is safe", () => {
  const r = analyzeCommits([
    commit({
      authorName: "octocat",
      authorEmail: "1+octocat@users.noreply.github.com",
    }),
  ]);
  assert.equal(r.highCount, 0);
  assert.equal(r.safeCount, 1);
});

test("co-author trailer with personal email is caught", () => {
  const r = analyzeCommits([
    commit({
      authorEmail: "1+a@users.noreply.github.com",
      message: "Fix\n\nCo-authored-by: Bob Real <bob@personal.dev>",
    }),
  ]);
  const bob = r.identities.find((i) => i.email === "bob@personal.dev");
  assert.ok(bob);
  assert.equal(bob.severity, "high");
  assert.ok(bob.trailerKinds.includes("coauthor"));
});

test("allowlist ignores matching emails and domains", () => {
  const r = analyzeCommits(
    [
      commit({ authorEmail: "jane@acme.com" }),
      commit({ authorEmail: "ci@bots.internal" }),
    ],
    { allow: ["*@acme.com", "ci@bots.internal"] }
  );
  assert.equal(r.identities.length, 0);
});

test("hidden history: newest noreply, older personal", () => {
  const r = analyzeCommits([
    commit({ authorEmail: "1+me@users.noreply.github.com" }), // newest
    commit({ authorEmail: "me@personal.dev" }), // older
  ]);
  assert.equal(r.hiddenHistory, true);
});

test("parseLog round-trips fields", () => {
  const F = "\x1f";
  const R = "\x1e";
  const raw =
    ["abc", "Jane Dev", "jane@acme.com", "Jane Dev", "jane@acme.com", "Subject\n\nBody"].join(F) +
    R;
  const [c] = parseLog(raw);
  assert.equal(c.sha, "abc");
  assert.equal(c.authorEmail, "jane@acme.com");
  assert.equal(c.message, "Subject\n\nBody");
});
