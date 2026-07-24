import { useEffect, useRef, useState, type FormEvent } from "react";

// ============ TYPES ============

interface EmailEntry {
  email: string;
  displayEmail: string;
  roles: string[];
  commitCount: number;
  classification: "exposed" | "noreply";
}

interface ScanResult {
  repoFullName: string;
  totalCommits: number;
  commitsScanned: number;
  emails: EmailEntry[];
  exposedCount: number;
  safeCount: number;
}

type NodeState = "pending" | "active" | "done";
type Mood = "idle" | "sniffing" | "alert" | "happy" | "confused";

interface CommitData {
  sha: string;
  commit: {
    author: { email: string; name: string };
    committer: { email: string; name: string };
  };
}

const RECENT_KEY = "gitbark:recent";
const EXAMPLES = ["torvalds/linux", "facebook/react", "nodejs/node"];

// ============ UTILITIES ============

function parseRepoInput(
  input: string
): { owner: string; repo: string } | null {
  let cleaned = input.trim().replace(/\.git$/, "").replace(/\/$/, "");

  if (cleaned.includes("github.com")) {
    if (!cleaned.startsWith("http")) cleaned = "https://" + cleaned;
    try {
      const url = new URL(cleaned);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) return { owner: parts[0], repo: parts[1] };
    } catch {
      /* invalid URL, try next */
    }
  }

  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length === 2) return { owner: parts[0], repo: parts[1] };

  return null;
}

function isGitHubNoreply(email: string): boolean {
  return (
    email.endsWith("@users.noreply.github.com") ||
    email === "noreply@github.com"
  );
}

function obfuscateEmail(email: string): string {
  if (isGitHubNoreply(email)) return email;
  const atIndex = email.indexOf("@");
  if (atIndex <= 0) return email;
  const local = email.substring(0, atIndex);
  const domain = email.substring(atIndex);
  const visible = local.substring(0, 1);
  const starCount = Math.min(Math.max(local.length - 1, 3), 6);
  return `${visible}${"*".repeat(starCount)}${domain}`;
}

function classifyEmail(email: string): "exposed" | "noreply" {
  return isGitHubNoreply(email) ? "noreply" : "exposed";
}

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(0, 5) : [];
  } catch {
    return [];
  }
}

function saveRecent(repos: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(repos.slice(0, 5)));
  } catch {
    /* storage unavailable, non-fatal */
  }
}

// ============ API ============

function parseLinkHeader(header: string | null): number {
  if (!header) return 1;
  const match = header.match(/<[^>]+[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return match ? parseInt(match[1], 10) : 1;
}

async function fetchRepoInfo(
  owner: string,
  repo: string
): Promise<{ total: number; latestCommit: CommitData }> {
  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?per_page=1`
  );

  if (res.status === 404)
    throw new Error(
      "Repository not found. Make sure it's public and the name is correct."
    );
  if (res.status === 409)
    throw new Error("Repository is empty — no commits to scan.");
  if (res.status === 403 || res.status === 429) {
    throw new Error("GitHub API rate limit exceeded (60 req/hr). Try again later.");
  }
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}.`);

  const data: CommitData[] = await res.json();
  if (!Array.isArray(data) || data.length === 0)
    throw new Error("No commits found in this repository.");

  const total = parseLinkHeader(res.headers.get("Link"));
  return { total, latestCommit: data[0] };
}

async function fetchCommitAtPage(
  owner: string,
  repo: string,
  page: number
): Promise<CommitData> {
  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?per_page=1&page=${page}`
  );
  if (!res.ok) throw new Error(`Failed to fetch commit at page ${page}.`);
  const data: CommitData[] = await res.json();
  if (!data.length) throw new Error(`No commit found at page ${page}.`);
  return data[0];
}

// ============ ANALYSIS ============

function analyzeCommits(
  commits: CommitData[],
  totalCommits: number,
  repoFullName: string
): ScanResult {
  const emailMap = new Map<string, { roles: Set<string>; shas: Set<string> }>();

  for (const commit of commits) {
    const authorEmail = commit.commit.author?.email;
    const committerEmail = commit.commit.committer?.email;

    if (authorEmail && authorEmail.includes("@")) {
      if (!emailMap.has(authorEmail))
        emailMap.set(authorEmail, { roles: new Set(), shas: new Set() });
      emailMap.get(authorEmail)!.roles.add("author");
      emailMap.get(authorEmail)!.shas.add(commit.sha);
    }

    if (committerEmail && committerEmail.includes("@")) {
      if (!emailMap.has(committerEmail))
        emailMap.set(committerEmail, { roles: new Set(), shas: new Set() });
      emailMap.get(committerEmail)!.roles.add("committer");
      emailMap.get(committerEmail)!.shas.add(commit.sha);
    }
  }

  const emails: EmailEntry[] = [];
  let exposedCount = 0;
  let safeCount = 0;

  for (const [email, data] of emailMap) {
    const classification = classifyEmail(email);
    if (classification === "exposed") exposedCount++;
    else safeCount++;

    emails.push({
      email,
      displayEmail: obfuscateEmail(email),
      roles: [...data.roles],
      commitCount: data.shas.size,
      classification,
    });
  }

  emails.sort((a, b) => {
    if (a.classification !== b.classification)
      return a.classification === "exposed" ? -1 : 1;
    return b.commitCount - a.commitCount;
  });

  return {
    repoFullName,
    totalCommits,
    commitsScanned: commits.length,
    emails,
    exposedCount,
    safeCount,
  };
}

// ============ REPORT ============

function generateReport(result: ScanResult): string {
  const lines: string[] = [];
  lines.push("  __");
  lines.push(" (o o)   gitbark — watchdog scan report");
  lines.push("(  V  )  woof.");
  lines.push("/--m-m-  " + "=".repeat(34));
  lines.push(`Repository:      ${result.repoFullName}`);
  lines.push(`Scan date:       ${new Date().toISOString().split("T")[0]}`);
  lines.push(`Scan type:       boundary (latest / mid / oldest)`);
  lines.push(`Total commits:   ${result.totalCommits}`);
  lines.push(`Commits sampled: ${result.commitsScanned}`);
  lines.push(`Unique emails:   ${result.emails.length}`);
  lines.push(`Exposed:         ${result.exposedCount}`);
  lines.push(`Safe:            ${result.safeCount}`);
  lines.push("");
  lines.push("-".repeat(42));

  for (const entry of result.emails) {
    const tag = entry.classification === "noreply" ? "SAFE   " : "EXPOSED";
    lines.push(`[${tag}] ${entry.displayEmail}`);
    lines.push(
      `          ${entry.roles.join(" + ")} · ${entry.commitCount} sampled commit(s)`
    );
  }

  lines.push("");
  lines.push("-".repeat(42));
  lines.push("Emails are masked in this report. Generated by gitbark.");

  return lines.join("\n");
}

// ============ WATCHDOG MASCOT ============

function Watchdog({ mood }: { mood: Mood }) {
  return (
    <svg
      className={`watchdog mood-${mood}`}
      viewBox="0 0 96 96"
      role="img"
      aria-label={`Watchdog — ${mood}`}
    >
      {/* alert sparks */}
      {mood === "alert" && (
        <g className="wd-sparks" stroke="var(--exposed)" strokeWidth="2.4" strokeLinecap="round">
          <line x1="12" y1="20" x2="6" y2="14" />
          <line x1="84" y1="20" x2="90" y2="14" />
          <line x1="9" y1="34" x2="2" y2="33" />
          <line x1="87" y1="34" x2="94" y2="33" />
        </g>
      )}
      {/* scent particles while sniffing */}
      {mood === "sniffing" && (
        <g className="wd-scent" fill="var(--accent)">
          <circle cx="70" cy="60" r="2" />
          <circle cx="78" cy="52" r="1.6" />
          <circle cx="84" cy="46" r="1.2" />
        </g>
      )}

      {/* ears */}
      <g className="wd-ears" fill="var(--coat)">
        <path className="wd-ear-l" d="M20 46 L26 14 L42 40 Z" />
        <path className="wd-ear-r" d="M76 46 L70 14 L54 40 Z" />
      </g>

      {/* head */}
      <circle cx="48" cy="52" r="30" fill="var(--coat)" />
      {/* light face patch so features read on the coat */}
      <ellipse cx="48" cy="57" rx="21" ry="22" fill="var(--coat-hi)" />

      {/* eyes */}
      {mood === "happy" ? (
        <g stroke="var(--ink)" strokeWidth="3.4" strokeLinecap="round" fill="none">
          <path d="M32 47 Q37 41 42 47" />
          <path d="M54 47 Q59 41 64 47" />
        </g>
      ) : (
        <g fill="var(--ink)">
          <circle className="wd-eye" cx="38" cy="48" r={mood === "alert" ? 5 : 4} />
          <circle className="wd-eye" cx="58" cy="48" r={mood === "alert" ? 5 : 4} />
          <circle cx="39.6" cy="46.4" r="1.3" fill="rgba(255,255,255,0.9)" />
          <circle cx="59.6" cy="46.4" r="1.3" fill="rgba(255,255,255,0.9)" />
        </g>
      )}

      {/* brow for confused */}
      {mood === "confused" && (
        <path
          d="M31 41 L44 44"
          stroke="var(--ink)"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
      )}

      {/* nose */}
      <ellipse className="wd-nose" cx="48" cy="58" rx="5" ry="4" fill="var(--ink)" />

      {/* mouth / bark */}
      {mood === "alert" ? (
        <g>
          <path
            className="wd-bark"
            d="M40 66 Q48 60 56 66 Q54 77 48 77 Q42 77 40 66 Z"
            fill="var(--ink)"
          />
          <path d="M45 70 Q48 74 51 70 Z" fill="var(--exposed)" />
        </g>
      ) : mood === "happy" ? (
        <g>
          <path
            d="M39 64 Q48 73 57 64"
            stroke="var(--ink)"
            strokeWidth="3"
            fill="none"
            strokeLinecap="round"
          />
          <path
            className="wd-tongue"
            d="M45 69 Q48 80 51 69 Z"
            fill="var(--exposed)"
          />
        </g>
      ) : (
        <path
          d="M42 65 Q48 70 54 65"
          stroke="var(--ink)"
          strokeWidth="2.8"
          fill="none"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

// ============ APP ============

function moodFor(
  scanning: boolean,
  error: string,
  result: ScanResult | null
): Mood {
  if (scanning) return "sniffing";
  if (error) return "confused";
  if (result) {
    if (result.exposedCount > 0) return "alert";
    if (result.emails.length === 0) return "confused";
    return "happy";
  }
  return "idle";
}

function barkFor(
  scanning: boolean,
  error: string,
  result: ScanResult | null,
  status: string
): string {
  if (scanning) return status || "Working…";
  if (error) return error;
  if (result) {
    if (result.exposedCount > 0) {
      const n = result.exposedCount;
      return `${n} email${n > 1 ? "s are" : " is"} exposed in this repo's commit history.`;
    }
    if (result.emails.length === 0)
      return "No emails turned up in the sampled commits.";
    return "All clear — only GitHub noreply addresses in here.";
  }
  return "Give me a public repo and I'll check which emails its commits reveal.";
}

export default function App() {
  const [input, setInput] = useState("");
  const [scanning, setScanning] = useState(false);
  const [nodes, setNodes] = useState<Record<string, NodeState>>({
    latest: "pending",
    mid: "pending",
    oldest: "pending",
  });
  const [status, setStatus] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const scanningRef = useRef(false);

  const mood = moodFor(scanning, error, result);
  const bark = barkFor(scanning, error, result, status);

  function setNode(key: string, state: NodeState) {
    setNodes((prev) => ({ ...prev, [key]: state }));
  }

  async function runScan(rawInput: string) {
    if (scanningRef.current) return;

    const parsed = parseRepoInput(rawInput);
    if (!parsed) {
      setError("That doesn't look like a repo. Use owner/repo or a GitHub URL.");
      setResult(null);
      return;
    }

    const { owner, repo } = parsed;
    const repoFullName = `${owner}/${repo}`;

    // Reset
    scanningRef.current = true;
    setScanning(true);
    setNodes({ latest: "pending", mid: "pending", oldest: "pending" });
    setStatus("");
    setResult(null);
    setError("");
    setCopied(false);
    setRevealed(new Set());

    // Reflect the scan in the URL so it can be shared / bookmarked.
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("repo", repoFullName);
      window.history.replaceState(null, "", url);
    } catch {
      /* non-fatal */
    }

    try {
      setNode("latest", "active");
      setStatus("Reading the latest commit…");

      const { total, latestCommit } = await fetchRepoInfo(owner, repo);
      setNode("latest", "done");

      const allCommits: CommitData[] = [latestCommit];
      const midPage = Math.ceil(total / 2);

      if (midPage !== 1 && midPage !== total) {
        setNode("mid", "active");
        setStatus(`Checking mid-history (${midPage} of ${total})…`);
        allCommits.push(await fetchCommitAtPage(owner, repo, midPage));
        setNode("mid", "done");
      } else {
        setNode("mid", "done");
      }

      if (total > 1) {
        setNode("oldest", "active");
        setStatus(`Fetching the first commit (${total} of ${total})…`);
        allCommits.push(await fetchCommitAtPage(owner, repo, total));
        setNode("oldest", "done");
      } else {
        setNode("oldest", "done");
      }

      setStatus("Analyzing…");
      await new Promise((r) => setTimeout(r, 350));

      const scanResult = analyzeCommits(allCommits, total, repoFullName);
      setResult(scanResult);

      setRecent((prev) => {
        const next = [repoFullName, ...prev.filter((r) => r !== repoFullName)].slice(0, 5);
        saveRecent(next);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unexpected error occurred.");
    } finally {
      scanningRef.current = false;
      setScanning(false);
      setStatus("");
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    runScan(input);
  }

  function scanRepo(repoFullName: string) {
    setInput(repoFullName);
    runScan(repoFullName);
  }

  function goHome(e: React.MouseEvent) {
    // Soft reset to the initial state without a full page reload.
    e.preventDefault();
    setInput("");
    setResult(null);
    setError("");
    setStatus("");
    setCopied(false);
    setRevealed(new Set());
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("repo");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    } catch {
      /* non-fatal */
    }
  }

  // Load recent scans + honor ?repo= on first mount.
  useEffect(() => {
    setRecent(loadRecent());
    const params = new URLSearchParams(window.location.search);
    const preset = params.get("repo");
    if (preset) {
      setInput(preset);
      runScan(preset);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleReveal(email: string) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        return true;
      } catch {
        return false;
      }
    }
  }

  async function handleCopyReport() {
    if (!result) return;
    if (await copyText(generateReport(result))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  function handleDownloadReport() {
    if (!result) return;
    const blob = new Blob([generateReport(result)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gitbark-${result.repoFullName.replace("/", "-")}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function handleCopyEmail(email: string) {
    if (await copyText(email)) {
      setCopiedEmail(email);
      setTimeout(() => setCopiedEmail((cur) => (cur === email ? null : cur)), 1500);
    }
  }

  const bubbleTone =
    mood === "alert" ? "tone-alert" : mood === "happy" ? "tone-safe" : mood === "confused" ? "tone-warn" : "tone-neutral";

  return (
    <div className="app">
      <header className="header">
        <div className="logo-row">
          <h1 className="logo">
            <a href="/" className="logo-home" onClick={goHome}>
              git<span className="logo-accent">bark</span>
            </a>
          </h1>
          <span className="version-tag">watchdog</span>
        </div>
        <p className="tagline">the repo email watchdog</p>
      </header>

      {/* Watchdog hero — always visible, reacts to state */}
      <section className={`kennel ${bubbleTone}`}>
        <div className="dog-stage">
          <Watchdog mood={mood} />
        </div>
        <div className="speech" aria-live="polite">
          <p className="speech-text">{bark}</p>
        </div>
      </section>

      <main>
        <p className="description">
          Every git commit embeds an email in its metadata. On public repos
          anyone can read it — just append <code>.patch</code> to a commit URL.
          gitbark fetches boundary commits (latest, mid, oldest) and barks if a
          personal email is exposed.
        </p>

        <form className="scan-form" onSubmit={handleSubmit}>
          <div className="input-group">
            <span className="input-prompt">$</span>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="owner/repo or github.com/owner/repo"
              disabled={scanning}
              autoFocus
              spellCheck={false}
              autoCapitalize="off"
            />
            <button
              type="submit"
              className="scan-btn"
              disabled={scanning || !input.trim()}
            >
              {scanning ? "Scanning…" : "Scan"}
            </button>
          </div>
          <p className="input-hint">
            Public repos only · samples 3 boundary commits · 60 requests/hr
          </p>
        </form>

        {/* Recent + example chips */}
        {!scanning && !result && (
          <div className="chips-block">
            {recent.length > 0 && (
              <div className="chip-group">
                <span className="chip-label">recent</span>
                {recent.map((r) => (
                  <button key={r} className="chip" onClick={() => scanRepo(r)}>
                    {r}
                  </button>
                ))}
              </div>
            )}
            <div className="chip-group">
              <span className="chip-label">try</span>
              {EXAMPLES.map((r) => (
                <button key={r} className="chip chip-example" onClick={() => scanRepo(r)}>
                  {r}
                </button>
              ))}
            </div>
          </div>
        )}

        {scanning && (
          <div className="scan-progress">
            <div className="timeline">
              <div className="timeline-node">
                <div className={`node-dot ${nodes.latest}`} />
                <span className="node-label">latest</span>
              </div>
              <div className="timeline-line" />
              <div className="timeline-node">
                <div className={`node-dot ${nodes.mid}`} />
                <span className="node-label">mid</span>
              </div>
              <div className="timeline-line" />
              <div className="timeline-node">
                <div className={`node-dot ${nodes.oldest}`} />
                <span className="node-label">oldest</span>
              </div>
            </div>
          </div>
        )}

        {result && (
          <div className="results">
            <div className="repo-line">
              <span className="repo-name">{result.repoFullName}</span>
              {recent.length > 0 && (
                <button
                  className="rescan-btn"
                  onClick={() => scanRepo(result.repoFullName)}
                  disabled={scanning}
                  title="Re-run scan"
                >
                  ↻ rescan
                </button>
              )}
            </div>

            <div className="summary">
              <div className="summary-stat">
                <div className="stat-value">{result.totalCommits}</div>
                <div className="stat-label">Total Commits</div>
              </div>
              <div className="summary-stat">
                <div className="stat-value">{result.emails.length}</div>
                <div className="stat-label">Emails Found</div>
              </div>
              <div className="summary-stat">
                <div
                  className={`stat-value ${result.exposedCount > 0 ? "text-exposed" : "text-safe"}`}
                >
                  {result.exposedCount}
                </div>
                <div className="stat-label">Exposed</div>
              </div>
            </div>

            {result.emails.length > 0 && result.exposedCount === 0 && (
              <div className="all-clear">
                All detected emails are GitHub noreply addresses. No personal
                emails exposed in sampled commits.
              </div>
            )}

            {result.emails.length > 0 && (
              <>
                <p className="section-label">Detected Emails</p>
                <div className="email-list">
                  {result.emails.map((entry, i) => {
                    const isRevealed = revealed.has(entry.email);
                    const shown =
                      entry.classification === "noreply" || isRevealed
                        ? entry.email
                        : entry.displayEmail;
                    return (
                      <div
                        key={entry.email}
                        className={`email-card ${entry.classification}`}
                        style={{ animationDelay: `${i * 70}ms` }}
                      >
                        <div className="email-row">
                          <span className="email-address">{shown}</span>
                          <span className={`risk-badge ${entry.classification}`}>
                            {entry.classification === "noreply" ? "safe" : "exposed"}
                          </span>
                        </div>
                        <div className="email-meta">
                          <span>{entry.roles.join(" + ")}</span>
                          <span className="dot-sep">·</span>
                          <span>
                            {entry.commitCount} commit
                            {entry.commitCount > 1 ? "s" : ""}
                          </span>
                          <span className="email-actions">
                            {entry.classification === "exposed" && (
                              <button
                                className="mini-btn"
                                onClick={() => toggleReveal(entry.email)}
                                title={isRevealed ? "Hide" : "Reveal full email"}
                              >
                                {isRevealed ? "hide" : "reveal"}
                              </button>
                            )}
                            <button
                              className="mini-btn"
                              onClick={() => handleCopyEmail(entry.email)}
                              title="Copy email"
                            >
                              {copiedEmail === entry.email ? "copied" : "copy"}
                            </button>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {result.emails.length === 0 && (
              <div className="no-emails">
                No emails detected in the {result.commitsScanned} sampled commit
                {result.commitsScanned > 1 ? "s" : ""}. The repo may use noreply
                emails, or the API returned no email data.
              </div>
            )}

            <div className="actions">
              <button
                className={`copy-btn ${copied ? "copied" : ""}`}
                onClick={handleCopyReport}
              >
                {copied ? "✓ copied report" : "copy report"}
              </button>
              <button className="copy-btn" onClick={handleDownloadReport}>
                download .txt
              </button>
            </div>

            {result.exposedCount > 0 && (
              <div className="fix-guide">
                <h3>How to fix email exposure</h3>
                <ol>
                  <li>
                    Go to GitHub <strong>Settings → Emails</strong>
                  </li>
                  <li>
                    Enable <strong>"Keep my email addresses private"</strong>
                  </li>
                  <li>
                    Enable{" "}
                    <strong>"Block command line pushes that expose my email"</strong>
                  </li>
                  <li>
                    Set your local git config:
                    <br />
                    <code>
                      git config --global user.email
                      "ID+USERNAME@users.noreply.github.com"
                    </code>
                  </li>
                  <li>
                    Old commits still contain the exposed email. Use{" "}
                    <code>git filter-repo</code> or <code>BFG Repo-Cleaner</code>{" "}
                    to rewrite history if needed.
                  </li>
                </ol>
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="footer">
        Scans public repos via the GitHub REST API. Nothing is stored or sent
        anywhere beyond api.github.com — the report masks emails by default.
        <br />
        Unauthenticated rate limit: 60 requests/hour per IP.
      </footer>
    </div>
  );
}
