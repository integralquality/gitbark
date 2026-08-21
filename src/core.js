// gitbark core — pure analysis, no I/O.
// Consumes normalized commit objects and reports which identities expose
// personal data in the git history.

/** @typedef {"email"|"name"|"coauthor"|"signoff"} ExposureType */
/** @typedef {"high"|"medium"|"safe"} Severity */

/**
 * @typedef {Object} Commit
 * @property {string} sha
 * @property {string} authorName
 * @property {string} authorEmail
 * @property {string} committerName
 * @property {string} committerEmail
 * @property {string} message
 */

const NOREPLY_RE = /@users\.noreply\.github\.com$/i;
const COAUTHOR_RE = /^[ \t]*Co-authored-by:[ \t]*(.+?)[ \t]*<([^>]+)>/gim;
const SIGNOFF_RE = /^[ \t]*Signed-off-by:[ \t]*(.+?)[ \t]*<([^>]+)>/gim;

/** A GitHub-provided privacy address, safe to commit. */
export function isGitHubNoreply(email) {
  const e = email.toLowerCase();
  return NOREPLY_RE.test(e) || e === "noreply@github.com";
}

/** Heuristic: a full personal name (has a space, isn't an email or a [bot]). */
export function isRealName(name) {
  const n = (name || "").trim();
  return /\s/.test(n) && !n.includes("@") && !/\[bot\]$/i.test(n);
}

/** Mask an email for safe display: j****@acme.com. Noreply addresses pass through. */
export function obfuscateEmail(email) {
  if (isGitHubNoreply(email)) return email;
  const at = email.indexOf("@");
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const stars = Math.min(Math.max(local.length - 1, 3), 6);
  return local[0] + "*".repeat(stars) + email.slice(at);
}

/**
 * Build allowlist matchers. Entries are exact emails or `*@domain.com` globs.
 * @param {string[]} entries
 */
function makeAllow(entries) {
  const list = entries.map((e) => e.trim().toLowerCase()).filter(Boolean);
  return (email) => {
    const e = email.toLowerCase();
    return list.some((a) => (a.startsWith("*@") ? e.endsWith(a.slice(1)) : e === a));
  };
}

function computeExposure(id) {
  /** @type {ExposureType[]} */
  const types = [];
  if (!id.isNoreply) types.push("email");
  if (id.names.some(isRealName)) types.push("name");
  if (id.trailerKinds.includes("coauthor")) types.push("coauthor");
  if (id.trailerKinds.includes("signoff")) types.push("signoff");
  id.types = types;
  id.severity = types.includes("email")
    ? "high"
    : types.length > 0
      ? "medium"
      : "safe";
}

const SEV_RANK = { high: 0, medium: 1, safe: 2 };

/**
 * Analyze a list of commits for exposed identities.
 * @param {Commit[]} commits  Newest-first (as `git log` emits).
 * @param {{ allow?: string[] }} [options]
 */
export function analyzeCommits(commits, options = {}) {
  const allowed = makeAllow(options.allow || []);
  const map = new Map();

  const ensure = (email) => {
    const key = email.toLowerCase();
    let id = map.get(key);
    if (!id) {
      id = {
        email,
        displayEmail: obfuscateEmail(email),
        isNoreply: isGitHubNoreply(email),
        names: [],
        roles: [],
        shas: new Set(),
        commitCount: 0,
        fromTrailerOnly: true,
        trailerKinds: [],
        types: [],
        severity: "safe",
      };
      map.set(key, id);
    }
    return id;
  };

  const record = (email, name, role, sha, fromTrailer, trailerKind) => {
    if (!email || !email.includes("@") || allowed(email)) return;
    const id = ensure(email);
    if (name && !id.names.includes(name)) id.names.push(name);
    if (!id.roles.includes(role)) id.roles.push(role);
    id.shas.add(sha);
    if (!fromTrailer) id.fromTrailerOnly = false;
    if (trailerKind && !id.trailerKinds.includes(trailerKind))
      id.trailerKinds.push(trailerKind);
  };

  for (const c of commits) {
    record(c.authorEmail, c.authorName, "author", c.sha, false);
    record(c.committerEmail, c.committerName, "committer", c.sha, false);

    const msg = c.message || "";
    for (const m of msg.matchAll(COAUTHOR_RE))
      record(m[2], m[1], "co-author", c.sha, true, "coauthor");
    for (const m of msg.matchAll(SIGNOFF_RE))
      record(m[2], m[1], "sign-off", c.sha, true, "signoff");
  }

  const identities = [...map.values()];
  for (const id of identities) {
    id.commitCount = id.shas.size;
    delete id.shas; // not serializable / not needed downstream
    computeExposure(id);
  }

  identities.sort((a, b) =>
    SEV_RANK[a.severity] !== SEV_RANK[b.severity]
      ? SEV_RANK[a.severity] - SEV_RANK[b.severity]
      : b.commitCount - a.commitCount
  );

  // Hidden history: the newest commit hides its email behind a noreply
  // address, but older commits still leak a personal one.
  const newest = commits[0];
  const newestEmails = [newest?.authorEmail, newest?.committerEmail].filter(
    (e) => e && e.includes("@")
  );
  const newestPersonal = newestEmails.some((e) => !isGitHubNoreply(e));
  const exposedElsewhere = identities.some((id) => !id.isNoreply && !id.fromTrailerOnly);
  const hiddenHistory = !newestPersonal && exposedElsewhere;

  return {
    totalCommits: commits.length,
    identities,
    highCount: identities.filter((i) => i.severity === "high").length,
    mediumCount: identities.filter((i) => i.severity === "medium").length,
    safeCount: identities.filter((i) => i.severity === "safe").length,
    hiddenHistory,
  };
}
