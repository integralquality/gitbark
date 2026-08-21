// Read commit metadata from a local git repository via `git log`.
// No network, no rate limits — reads whatever history is checked out.

import { execFileSync } from "node:child_process";

const FIELD = "\x1f"; // unit separator — delimits fields
const RECORD = "\x1e"; // record separator — delimits commits

/**
 * @param {string} out  Raw `git log` output in the format below.
 * @returns {import("./core.js").Commit[]}
 */
export function parseLog(out) {
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\s+/, ""))
    .filter(Boolean)
    .map((rec) => {
      const [sha, an, ae, cn, ce, ...rest] = rec.split(FIELD);
      return {
        sha,
        authorName: an || "",
        authorEmail: ae || "",
        committerName: cn || "",
        committerEmail: ce || "",
        message: rest.join(FIELD),
      };
    });
}

/**
 * Read commits from a local repo.
 * @param {{ cwd?: string, since?: string, max?: number }} [options]
 *   - since: only commits reachable from HEAD but not from `since` (e.g. "origin/main"),
 *            i.e. `since..HEAD`. Omit to scan all history across every ref.
 *   - max: cap the number of commits read.
 */
export function readCommits(options = {}) {
  const { cwd = process.cwd(), since, max } = options;
  const format = ["%H", "%an", "%ae", "%cn", "%ce", "%B"].join(FIELD) + RECORD;
  const args = ["log", `--format=${format}`, "--no-color"];
  if (max) args.push(`--max-count=${max}`);
  args.push(since ? `${since}..HEAD` : "--all");

  let out;
  try {
    out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch (err) {
    const stderr = (err && err.stderr ? String(err.stderr) : "").trim();
    throw new Error(
      stderr ||
        `Failed to run git in "${cwd}". Is it a git repository with commits?`
    );
  }
  return parseLog(out);
}

/** True if `dir` looks like a git working tree. */
export function isGitRepo(cwd = process.cwd()) {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
