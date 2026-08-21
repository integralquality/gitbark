// Output formatting: human-readable text, JSON, and GitHub Actions
// annotations + job summary.

import { appendFileSync } from "node:fs";

const TYPE_LABELS = {
  email: "personal email",
  name: "real name",
  coauthor: "co-author leak",
  signoff: "sign-off",
};

/** One-line description of what an identity exposes. */
function exposes(id) {
  return id.types.map((t) => TYPE_LABELS[t]).join(", ") || "nothing personal";
}

/**
 * Human-readable report.
 * @param {ReturnType<import("./core.js").analyzeCommits>} result
 * @param {{ repo?: string, deep?: boolean }} [meta]
 */
export function formatReport(result, meta = {}) {
  const L = [];
  L.push(`gitbark — ${meta.repo || "repository"}`);
  L.push("=".repeat(48));
  L.push(`Commits scanned: ${result.totalCommits}`);
  L.push(`Identities:      ${result.identities.length}`);
  L.push(`High risk:       ${result.highCount}`);
  L.push(`Medium:          ${result.mediumCount}`);
  L.push(`Safe:            ${result.safeCount}`);
  if (result.hiddenHistory)
    L.push(`Note:            recent commits hide emails still present in history`);
  L.push("");

  const flagged = result.identities.filter((i) => i.severity !== "safe");
  if (flagged.length === 0) {
    L.push("No personal data exposed in the scanned commits. ✓");
    return L.join("\n");
  }

  for (const id of flagged) {
    const tag = id.severity.toUpperCase().padEnd(6);
    const name = id.names[0] || "(no name)";
    L.push(`[${tag}] ${name}  <${id.displayEmail}>`);
    L.push(`         exposes: ${exposes(id)}`);
    L.push(
      `         ${id.roles.join(" + ")} · ${id.commitCount} commit${id.commitCount === 1 ? "" : "s"}`
    );
  }
  L.push("");
  L.push("Emails are masked. See https://github.com/792401/gitbark to fix exposure.");
  return L.join("\n");
}

const ESC = (s) =>
  String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/** Emit ::error:: / ::warning:: workflow commands so findings show in the PR. */
export function emitAnnotations(result, log = console.log) {
  for (const id of result.identities) {
    if (id.severity === "safe") continue;
    const name = id.names[0] || id.displayEmail;
    const level = id.severity === "high" ? "error" : "warning";
    log(
      `::${level} title=gitbark::${ESC(`${name} exposes ${exposes(id)} in commit history`)}`
    );
  }
  if (result.hiddenHistory)
    log(
      `::warning title=gitbark::${ESC("Recent commits hide emails, but older history still exposes them")}`
    );
}

/** Append a Markdown summary to the Actions job summary, if available. */
export function writeStepSummary(result, meta = {}) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const M = [];
  M.push(`### gitbark — ${meta.repo || "scan"}`);
  M.push("");
  M.push(`| | count |`);
  M.push(`|---|---|`);
  M.push(`| Commits scanned | ${result.totalCommits} |`);
  M.push(`| 🔴 High risk | ${result.highCount} |`);
  M.push(`| 🟡 Medium | ${result.mediumCount} |`);
  M.push(`| 🟢 Safe | ${result.safeCount} |`);
  M.push("");
  const flagged = result.identities.filter((i) => i.severity !== "safe");
  if (flagged.length) {
    M.push(`| identity | exposes | commits |`);
    M.push(`|---|---|---|`);
    for (const id of flagged)
      M.push(
        `| ${id.names[0] || "(no name)"} \`${id.displayEmail}\` | ${exposes(id)} | ${id.commitCount} |`
      );
  } else {
    M.push("No personal data exposed. ✓");
  }
  try {
    appendFileSync(file, M.join("\n") + "\n");
  } catch {
    /* summary is best-effort */
  }
}
