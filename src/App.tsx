import { useState, type FormEvent } from "react";

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

interface CommitData {
  sha: string;
  commit: {
    author: { email: string; name: string };
    committer: { email: string; name: string };
  };
}

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

// ============ API ============

function parseLinkHeader(header: string | null): number {
  if (!header) return 1;
  const match = header.match(
    /<[^>]+[?&]page=(\d+)[^>]*>;\s*rel="last"/
  );
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
    throw new Error("Repository not found. Make sure it's public and the name is correct.");
  if (res.status === 409) throw new Error("Repository is empty — no commits to scan.");
  if (res.status === 403 || res.status === 429) {
    throw new Error(
      "GitHub API rate limit exceeded (60 req/hr). Try again later."
    );
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
  const emailMap = new Map<
    string,
    { roles: Set<string>; shas: Set<string> }
  >();

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
  lines.push("git-peek — scan report");
  lines.push("=".repeat(42));
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
    const tag = entry.classification === "noreply" ? "SAFE" : "EXPOSED";
    lines.push(`[${tag}] ${entry.displayEmail}`);
    lines.push(
      `  Role: ${entry.roles.join(" + ")}  |  ${entry.commitCount} sampled commit(s)`
    );
    lines.push("");
  }

  lines.push("-".repeat(42));
  lines.push("Generated by git-peek");

  return lines.join("\n");
}

// ============ APP ============

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

  function setNode(key: string, state: NodeState) {
    setNodes((prev) => ({ ...prev, [key]: state }));
  }

  async function handleScan(e: FormEvent) {
    e.preventDefault();

    const parsed = parseRepoInput(input);
    if (!parsed) {
      setError("Invalid format. Use owner/repo or a full GitHub URL.");
      return;
    }

    const { owner, repo } = parsed;
    const repoFullName = `${owner}/${repo}`;

    // Reset
    setScanning(true);
    setNodes({ latest: "pending", mid: "pending", oldest: "pending" });
    setStatus("");
    setResult(null);
    setError("");
    setCopied(false);

    try {
      // Step 1: Get repo info + latest commit
      setNode("latest", "active");
      setStatus("Connecting to repository...");

      const { total, latestCommit } = await fetchRepoInfo(owner, repo);
      setNode("latest", "done");

      const allCommits: CommitData[] = [latestCommit];
      const midPage = Math.ceil(total / 2);

      // Step 2: Fetch mid commit (if distinct from latest and oldest)
      if (midPage !== 1 && midPage !== total) {
        setNode("mid", "active");
        setStatus(
          `Scanning mid-history commit (${midPage} of ${total})...`
        );
        const midCommit = await fetchCommitAtPage(owner, repo, midPage);
        allCommits.push(midCommit);
        setNode("mid", "done");
      } else {
        setNode("mid", "done");
      }

      // Step 3: Fetch oldest commit (if distinct from latest)
      if (total > 1) {
        setNode("oldest", "active");
        setStatus(
          `Scanning oldest commit (${total} of ${total})...`
        );
        const oldestCommit = await fetchCommitAtPage(owner, repo, total);
        allCommits.push(oldestCommit);
        setNode("oldest", "done");
      } else {
        setNode("oldest", "done");
      }

      // Step 4: Analyze
      setStatus("Analyzing...");
      await new Promise((r) => setTimeout(r, 350));

      const scanResult = analyzeCommits(allCommits, total, repoFullName);
      setResult(scanResult);
      setScanning(false);
      setStatus("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "An unexpected error occurred."
      );
      setScanning(false);
      setStatus("");
    }
  }

  async function handleCopy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(generateReport(result));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement("textarea");
      textarea.value = generateReport(result);
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <h1 className="logo">
          git<span className="logo-accent">-peek</span>
        </h1>
        <p className="tagline">commit email exposure scanner</p>
      </header>

      <main>
        <form className="scan-form" onSubmit={handleScan}>
          <div className="input-group">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="owner/repo or github.com/owner/repo"
              disabled={scanning}
              autoFocus
            />
            <button
              type="submit"
              className="scan-btn"
              disabled={scanning || !input.trim()}
            >
              {scanning ? "Scanning..." : "Scan"}
            </button>
          </div>
          <p className="input-hint">
            Public repositories only. Samples 3 boundary commits (latest, mid,
            oldest).
          </p>
        </form>

        {error && <div className="error-message">{error}</div>}

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
            <p className="scan-status">{status}</p>
          </div>
        )}

        {result && (
          <div className="results">
            {/* Summary */}
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

            {/* All clear message */}
            {result.emails.length > 0 && result.exposedCount === 0 && (
              <div className="all-clear">
                All detected emails are GitHub noreply addresses. No personal
                emails exposed in sampled commits.
              </div>
            )}

            {/* Email list */}
            {result.emails.length > 0 && (
              <>
                <p className="section-label">Detected Emails</p>
                <div className="email-list">
                  {result.emails.map((entry, i) => (
                    <div
                      key={entry.email}
                      className={`email-card ${entry.classification}`}
                      style={{ animationDelay: `${i * 80}ms` }}
                    >
                      <div className="email-row">
                        <span className="email-address">
                          {entry.displayEmail}
                        </span>
                        <span
                          className={`risk-badge ${entry.classification}`}
                        >
                          {entry.classification === "noreply"
                            ? "safe"
                            : "exposed"}
                        </span>
                      </div>
                      <div className="email-meta">
                        <span>{entry.roles.join(" + ")}</span>
                        <span>·</span>
                        <span>
                          {entry.commitCount} commit
                          {entry.commitCount > 1 ? "s" : ""}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* No emails */}
            {result.emails.length === 0 && (
              <div className="no-emails">
                No emails detected in the {result.commitsScanned} sampled
                commit{result.commitsScanned > 1 ? "s" : ""}. The repository
                may use noreply emails or the API did not return email data.
              </div>
            )}

            {/* Actions */}
            <div className="actions">
              <button
                className={`copy-btn ${copied ? "copied" : ""}`}
                onClick={handleCopy}
              >
                {copied ? "Copied to clipboard" : "Copy report"}
              </button>
            </div>

            {/* Fix guide (only shown when there are exposed emails) */}
            {result.exposedCount > 0 && (
              <div className="fix-guide">
                <h3>How to fix email exposure</h3>
                <ol>
                  <li>
                    Go to GitHub{" "}
                    <strong>Settings &rarr; Emails</strong>
                  </li>
                  <li>
                    Enable{" "}
                    <strong>
                      "Keep my email addresses private"
                    </strong>
                  </li>
                  <li>
                    Enable{" "}
                    <strong>
                      "Block command line pushes that expose my email"
                    </strong>
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
                    <code>git filter-repo</code> or{" "}
                    <code>BFG Repo-Cleaner</code> to rewrite history if
                    needed.
                  </li>
                </ol>
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="footer">
        Scans public repos via GitHub REST API. No data stored or sent
        anywhere beyond api.github.com.
        <br />
        Unauthenticated rate limit: 60 requests/hour per IP.
      </footer>
    </div>
  );
}
