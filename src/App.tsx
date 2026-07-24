import { useEffect, useRef, useState } from "react";
import type { FormEvent, MouseEvent as ReactMouseEvent } from "react";

// ============ TYPES ============

type Severity = "high" | "medium" | "safe";
type ExposureType =
  | "email"
  | "name"
  | "location"
  | "company"
  | "social"
  | "coauthor"
  | "signoff"
  | "photo";

interface ProfileInfo {
  name?: string;
  company?: string;
  location?: string;
  blog?: string;
  twitter?: string;
}

interface Identity {
  key: string;
  email: string; // primary git email
  displayEmail: string;
  isNoreply: boolean;
  publicEmail?: string; // from GitHub profile
  names: string[];
  login?: string;
  avatarUrl?: string;
  gravatarUrl?: string;
  roles: string[];
  shas: Set<string>;
  commitCount: number;
  fromTrailerOnly: boolean;
  trailerKinds: string[];
  profile?: ProfileInfo;
  types: ExposureType[];
  severity: Severity;
  isYou?: boolean;
}

interface ScanResult {
  repoFullName: string;
  totalCommits: number;
  commitsScanned: number;
  identities: Identity[];
  highCount: number;
  mediumCount: number;
  safeCount: number;
  hiddenHistory: boolean;
  deepScan: boolean;
}

type NodeState = "pending" | "active" | "done";
type Mood = "idle" | "sniffing" | "alert" | "happy" | "confused";

interface GitUser {
  email: string;
  name: string;
}

interface CommitData {
  sha: string;
  commit: {
    author: GitUser;
    committer: GitUser;
    message: string;
  };
  author: { login: string; avatar_url: string } | null;
  committer: { login: string; avatar_url: string } | null;
}

const RECENT_KEY = "gitbark:recent";
const EXAMPLES = ["torvalds/linux", "facebook/react", "nodejs/node"];

const TYPE_LABELS: Record<ExposureType, string> = {
  email: "email",
  name: "real name",
  location: "location",
  company: "company",
  social: "social handle",
  coauthor: "co-author leak",
  signoff: "sign-off",
  photo: "public photo",
};

// Exposures discovered on the contributor's GitHub profile, not in the repo.
const PROFILE_TYPES = new Set<ExposureType>(["location", "company", "social"]);

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

function isRealName(name: string): boolean {
  const n = name.trim();
  return /\s/.test(n) && !n.includes("@") && !/\[bot\]$/i.test(n);
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

async function fetchProfile(login: string): Promise<
  (ProfileInfo & { publicEmail?: string; avatarUrl?: string }) | null
> {
  try {
    const res = await fetch(
      `https://api.github.com/users/${encodeURIComponent(login)}`
    );
    if (!res.ok) return null;
    const d = await res.json();
    return {
      name: d.name || undefined,
      company: d.company || undefined,
      location: d.location || undefined,
      blog: d.blog || undefined,
      twitter: d.twitter_username || undefined,
      publicEmail: d.email || undefined,
      avatarUrl: d.avatar_url || undefined,
    };
  } catch {
    return null;
  }
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Detect a public Gravatar for an email (separate host — no GitHub quota).
async function checkGravatar(email: string): Promise<string | null> {
  try {
    const hash = await sha256Hex(email.trim().toLowerCase());
    const probe = `https://gravatar.com/avatar/${hash}?s=96&d=404`;
    const exists = await new Promise<boolean>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = probe;
    });
    return exists ? `https://gravatar.com/avatar/${hash}?s=96` : null;
  } catch {
    return null;
  }
}

// ============ ANALYSIS ============

function computeExposure(id: Identity) {
  const types: ExposureType[] = [];
  const personalProfileEmail =
    !!id.publicEmail &&
    id.publicEmail.includes("@") &&
    !isGitHubNoreply(id.publicEmail);

  if (!id.isNoreply || personalProfileEmail) types.push("email");
  if (id.names.some(isRealName)) types.push("name");
  if (id.gravatarUrl) types.push("photo");
  if (id.profile?.location) types.push("location");
  if (id.profile?.company) types.push("company");
  if (id.profile?.blog || id.profile?.twitter) types.push("social");
  if (id.trailerKinds.includes("coauthor")) types.push("coauthor");
  if (id.trailerKinds.includes("signoff")) types.push("signoff");

  id.types = types;
  id.severity =
    types.includes("email") || types.includes("photo")
      ? "high"
      : types.length > 0
        ? "medium"
        : "safe";
}

const SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, safe: 2 };

function sortIdentities(ids: Identity[]): Identity[] {
  return [...ids].sort((a, b) => {
    if (!!b.isYou !== !!a.isYou) return a.isYou ? -1 : 1;
    if (SEV_RANK[a.severity] !== SEV_RANK[b.severity])
      return SEV_RANK[a.severity] - SEV_RANK[b.severity];
    return b.commitCount - a.commitCount;
  });
}

function finalize(
  identities: Identity[],
  base: Omit<
    ScanResult,
    "identities" | "highCount" | "mediumCount" | "safeCount"
  >
): ScanResult {
  const sorted = sortIdentities(identities);
  return {
    ...base,
    identities: sorted,
    highCount: sorted.filter((i) => i.severity === "high").length,
    mediumCount: sorted.filter((i) => i.severity === "medium").length,
    safeCount: sorted.filter((i) => i.severity === "safe").length,
  };
}

// "Highlight me" accepts comma-separated terms — a username, email, or name.
function parseFocus(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

function matchesFocus(id: Identity, terms: string[]): boolean {
  if (terms.length === 0) return false;
  const login = id.login?.toLowerCase();
  const emails = [id.email.toLowerCase()];
  if (id.publicEmail) emails.push(id.publicEmail.toLowerCase());
  const names = id.names.map((n) => n.toLowerCase());

  return terms.some((t) => {
    if (login && (login === t || (t.length >= 3 && login.includes(t)))) return true;
    for (const e of emails) {
      if (e === t || e.split("@")[0] === t) return true;
      if (t.length >= 3 && e.includes(t)) return true;
    }
    return names.some((n) => n === t || (t.length >= 3 && n.includes(t)));
  });
}

function baseAnalyze(
  commits: CommitData[],
  totalCommits: number,
  repoFullName: string,
  focusUser: string
): ScanResult {
  const map = new Map<string, Identity>();
  const focusTerms = parseFocus(focusUser);

  function ensure(email: string): Identity {
    const key = email.toLowerCase();
    let id = map.get(key);
    if (!id) {
      id = {
        key,
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
  }

  function record(
    email: string | undefined,
    name: string | undefined,
    role: string,
    sha: string,
    fromTrailer: boolean
  ) {
    if (!email || !email.includes("@")) return;
    const id = ensure(email);
    if (name && !id.names.includes(name)) id.names.push(name);
    if (!id.roles.includes(role)) id.roles.push(role);
    id.shas.add(sha);
    if (!fromTrailer) id.fromTrailerOnly = false;
  }

  const coauthorRe = /^[ \t]*Co-authored-by:[ \t]*(.+?)[ \t]*<([^>]+)>/gim;
  const signoffRe = /^[ \t]*Signed-off-by:[ \t]*(.+?)[ \t]*<([^>]+)>/gim;

  for (const c of commits) {
    const a = c.commit.author;
    const cm = c.commit.committer;

    record(a?.email, a?.name, "author", c.sha, false);
    record(cm?.email, cm?.name, "committer", c.sha, false);

    // Link GitHub account (login + avatar) to the git identity it authored.
    if (a?.email && c.author) {
      const id = map.get(a.email.toLowerCase());
      if (id) {
        id.login = id.login ?? c.author.login;
        id.avatarUrl = id.avatarUrl ?? c.author.avatar_url;
      }
    }
    if (cm?.email && c.committer) {
      const id = map.get(cm.email.toLowerCase());
      if (id) {
        id.login = id.login ?? c.committer.login;
        id.avatarUrl = id.avatarUrl ?? c.committer.avatar_url;
      }
    }

    const message = c.commit.message || "";
    for (const m of message.matchAll(coauthorRe)) {
      record(m[2], m[1], "co-author", c.sha, true);
      const id = map.get(m[2].toLowerCase());
      if (id && !id.trailerKinds.includes("coauthor"))
        id.trailerKinds.push("coauthor");
    }
    for (const m of message.matchAll(signoffRe)) {
      record(m[2], m[1], "sign-off", c.sha, true);
      const id = map.get(m[2].toLowerCase());
      if (id && !id.trailerKinds.includes("signoff"))
        id.trailerKinds.push("signoff");
    }
  }

  const identities = [...map.values()];
  for (const id of identities) {
    id.commitCount = id.shas.size;
    if (matchesFocus(id, focusTerms)) id.isYou = true;
    computeExposure(id);
  }

  // Hidden-history: newest commit hides its email, but older commits still leak.
  const latest = commits[0];
  const latestEmails = [
    latest?.commit.author?.email,
    latest?.commit.committer?.email,
  ].filter((e): e is string => !!e && e.includes("@"));
  const latestPersonal = latestEmails.some((e) => !isGitHubNoreply(e));
  const exposedElsewhere = identities.some(
    (id) => !id.isNoreply && !id.fromTrailerOnly
  );
  const hiddenHistory = !latestPersonal && exposedElsewhere;

  return finalize(identities, {
    repoFullName,
    totalCommits,
    commitsScanned: commits.length,
    hiddenHistory,
    deepScan: false,
  });
}

async function deepEnrich(
  result: ScanResult,
  focusUser: string,
  onStatus: (s: string) => void
): Promise<ScanResult> {
  const ids = result.identities;

  // 1) Public GitHub profiles (one request per unique login, capped).
  const logins = [...new Set(ids.filter((i) => i.login).map((i) => i.login!))].slice(
    0,
    12
  );
  if (logins.length > 0) {
    onStatus("Checking public profiles…");
    const profiles = new Map<
      string,
      ProfileInfo & { publicEmail?: string; avatarUrl?: string }
    >();
    for (const login of logins) {
      const p = await fetchProfile(login);
      if (p) profiles.set(login.toLowerCase(), p);
    }
    for (const id of ids) {
      if (!id.login) continue;
      const p = profiles.get(id.login.toLowerCase());
      if (!p) continue;
      id.profile = {
        name: p.name,
        company: p.company,
        location: p.location,
        blog: p.blog,
        twitter: p.twitter,
      };
      if (p.name && !id.names.includes(p.name)) id.names.push(p.name);
      if (p.avatarUrl && !id.avatarUrl) id.avatarUrl = p.avatarUrl;
      if (p.publicEmail && p.publicEmail.includes("@"))
        id.publicEmail = p.publicEmail;
    }
  }

  // 2) Gravatar linkage for any exposed email (separate host, no GitHub quota).
  onStatus("Checking Gravatar…");
  await Promise.all(
    ids.map(async (id) => {
      const email = !id.isNoreply ? id.email : id.publicEmail;
      if (!email || !email.includes("@")) return;
      const g = await checkGravatar(email);
      if (g) id.gravatarUrl = g;
    })
  );

  // Profile data may reveal a name/email that matches "highlight me".
  const focusTerms = parseFocus(focusUser);
  for (const id of ids) {
    if (matchesFocus(id, focusTerms)) id.isYou = true;
    computeExposure(id);
  }

  return finalize(ids, {
    repoFullName: result.repoFullName,
    totalCommits: result.totalCommits,
    commitsScanned: result.commitsScanned,
    hiddenHistory: result.hiddenHistory,
    deepScan: true,
  });
}

// ============ REPORT ============

function shownEmailFor(id: Identity, reveal: boolean): string {
  if (!id.isNoreply) return reveal ? id.email : id.displayEmail;
  if (id.publicEmail && !isGitHubNoreply(id.publicEmail))
    return reveal ? id.publicEmail : obfuscateEmail(id.publicEmail);
  return id.email;
}

function generateReport(result: ScanResult): string {
  const lines: string[] = [];
  lines.push("  __");
  lines.push(" (o o)   gitbark — watchdog scan report");
  lines.push("(  V  )  woof.");
  lines.push("/--m-m-  " + "=".repeat(34));
  lines.push(`Repository:      ${result.repoFullName}`);
  lines.push(`Scan date:       ${new Date().toISOString().split("T")[0]}`);
  lines.push(
    `Scan type:       boundary (latest / mid / oldest)${result.deepScan ? " + deep" : ""}`
  );
  lines.push(`Total commits:   ${result.totalCommits}`);
  lines.push(`Commits sampled: ${result.commitsScanned}`);
  lines.push(`Identities:      ${result.identities.length}`);
  lines.push(`High risk:       ${result.highCount}`);
  lines.push(`Medium:          ${result.mediumCount}`);
  lines.push(`Safe:            ${result.safeCount}`);
  if (result.hiddenHistory)
    lines.push("Note:            recent commits hide emails still in history");
  lines.push("");
  lines.push("-".repeat(42));

  for (const id of result.identities) {
    const tag = id.severity.toUpperCase().padEnd(6);
    const name = id.names[0] || "(no name)";
    lines.push(`[${tag}] ${name} — ${shownEmailFor(id, false)}`);
    lines.push(
      `          exposes: ${id.types.map((t) => TYPE_LABELS[t]).join(", ") || "nothing personal"}`
    );
    const meta = [
      id.roles.join(" + "),
      `${id.commitCount} commit${id.commitCount === 1 ? "" : "s"}`,
    ];
    if (id.profile?.location) meta.push(id.profile.location);
    if (id.profile?.company) meta.push(id.profile.company);
    lines.push(`          ${meta.join(" · ")}`);
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
      {mood === "alert" && (
        <g className="wd-sparks" stroke="var(--exposed)" strokeWidth="2.4" strokeLinecap="round">
          <line x1="12" y1="20" x2="6" y2="14" />
          <line x1="84" y1="20" x2="90" y2="14" />
          <line x1="9" y1="34" x2="2" y2="33" />
          <line x1="87" y1="34" x2="94" y2="33" />
        </g>
      )}
      {mood === "sniffing" && (
        <g className="wd-scent" fill="var(--accent)">
          <circle cx="70" cy="60" r="2" />
          <circle cx="78" cy="52" r="1.6" />
          <circle cx="84" cy="46" r="1.2" />
        </g>
      )}

      <g className="wd-ears" fill="var(--coat)">
        <path className="wd-ear-l" d="M20 46 L26 14 L42 40 Z" />
        <path className="wd-ear-r" d="M76 46 L70 14 L54 40 Z" />
      </g>

      <circle cx="48" cy="52" r="30" fill="var(--coat)" />
      <ellipse cx="48" cy="57" rx="21" ry="22" fill="var(--coat-hi)" />

      {mood === "happy" ? (
        <g stroke="var(--ink)" strokeWidth="3.4" strokeLinecap="round" fill="none">
          <path d="M32 47 Q37 41 42 47" />
          <path d="M54 47 Q59 41 64 47" />
        </g>
      ) : (
        <g fill="var(--ink)">
          <circle className="wd-eye" cx="38" cy="48" r={mood === "alert" ? 3.6 : 4} />
          <circle className="wd-eye" cx="58" cy="48" r={mood === "alert" ? 3.6 : 4} />
          <circle cx="39.6" cy="46.4" r="1.3" fill="rgba(255,255,255,0.9)" />
          <circle cx="59.6" cy="46.4" r="1.3" fill="rgba(255,255,255,0.9)" />
        </g>
      )}

      {mood === "confused" && (
        <path
          d="M31 41 L44 44"
          stroke="var(--ink)"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
      )}

      {mood === "alert" && (
        <g stroke="var(--ink)" strokeWidth="2.8" strokeLinecap="round">
          <path d="M31 42 L43 46" />
          <path d="M65 42 L53 46" />
        </g>
      )}

      <ellipse className="wd-nose" cx="48" cy="58" rx="5" ry="4" fill="var(--ink)" />

      {mood === "alert" ? (
        <g className="wd-bark">
          <path
            d="M39 64 Q48 61 57 64 Q58 76 48 79 Q38 76 39 64 Z"
            fill="var(--ink)"
          />
          <path d="M43 64.5 L45.5 68 L48 64.5 Z" fill="#fff" />
          <path d="M48 64.5 L50.5 68 L53 64.5 Z" fill="#fff" />
          <path d="M44.5 71 Q48 80 51.5 71 Z" fill="var(--exposed)" />
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

// ============ MOOD / BARK ============

function moodFor(
  scanning: boolean,
  error: string,
  result: ScanResult | null
): Mood {
  if (scanning) return "sniffing";
  if (error) return "confused";
  if (result) {
    if (result.highCount > 0) return "alert";
    if (result.identities.length === 0) return "confused";
    if (result.mediumCount === 0) return "happy";
    return "idle";
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
    const you = result.identities.find((i) => i.isYou);
    if (you && you.severity === "high") {
      const what = you.types.includes("email") ? "email" : "photo";
      return `Heads up — your ${what} is exposed in this repo's history.`;
    }
    if (result.hiddenHistory)
      return "Recent commits hide emails, but older history still exposes them.";
    if (result.highCount > 0) {
      const n = result.highCount;
      return `${n} ${n > 1 ? "people are" : "person is"} exposing personal data (email or photo).`;
    }
    if (result.mediumCount > 0) {
      const present = new Set<ExposureType>();
      result.identities.forEach((i) => i.types.forEach((t) => present.add(t)));
      const repoMed =
        present.has("name") || present.has("signoff") || present.has("coauthor");
      const profMed =
        present.has("location") || present.has("company") || present.has("social");
      if (repoMed && profMed)
        return "Real names sit in the commit history, and public GitHub profiles add location/company — but no emails leaked.";
      if (profMed)
        return "Nothing personal in the repo itself, but some contributors' public GitHub profiles reveal location or company.";
      return "Real names are exposed in the commit history, but no personal emails leaked.";
    }
    if (result.identities.length > 0)
      return "All clear — only noreply addresses, nothing personal.";
    return "No committer identities turned up in the sampled commits.";
  }
  return "Give me a public repo and I'll check which PII its commits reveal.";
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
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);

  // options
  const [showOptions, setShowOptions] = useState(false);
  const [focusUser, setFocusUser] = useState("");
  const [deepScan, setDeepScan] = useState(false);

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

    scanningRef.current = true;
    setScanning(true);
    setNodes({ latest: "pending", mid: "pending", oldest: "pending" });
    setStatus("");
    setResult(null);
    setError("");
    setCopied(false);
    setRevealed(new Set());

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
      await new Promise((r) => setTimeout(r, 300));

      let scanResult = baseAnalyze(allCommits, total, repoFullName, focusUser);
      if (deepScan) {
        scanResult = await deepEnrich(scanResult, focusUser, setStatus);
      }
      setResult(scanResult);

      setRecent((prev) => {
        const next = [
          repoFullName,
          ...prev.filter((r) => r !== repoFullName),
        ].slice(0, 5);
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

  function goHome(e: ReactMouseEvent) {
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

  function toggleReveal(key: string) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
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
      setTimeout(
        () => setCopiedEmail((cur) => (cur === email ? null : cur)),
        1500
      );
    }
  }

  const bubbleTone =
    mood === "alert"
      ? "tone-alert"
      : mood === "happy"
        ? "tone-safe"
        : "tone-neutral";

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
        <p className="tagline">the repo PII watchdog</p>
      </header>

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
          Every git commit embeds its author's identity — email and name — in
          metadata anyone can read on a public repo. gitbark samples boundary
          commits (latest, mid, oldest), then surfaces the emails, real names,
          co-author leaks and public profiles that are exposed.
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
          <div className="form-foot">
            <p className="input-hint">
              Public repos only · samples 3 boundary commits · 60 req/hr
            </p>
            <button
              type="button"
              className="options-toggle"
              onClick={() => setShowOptions((v) => !v)}
              aria-expanded={showOptions}
            >
              {showOptions ? "▾" : "▸"} options
            </button>
          </div>

          {showOptions && (
            <div className="options-panel">
              <label className="opt-field">
                <span className="opt-label">Highlight me</span>
                <input
                  type="text"
                  value={focusUser}
                  onChange={(e) => setFocusUser(e.target.value)}
                  placeholder="username, email, or name — comma-separated"
                  disabled={scanning}
                  spellCheck={false}
                  autoCapitalize="off"
                />
                <span className="opt-note">
                  e.g. <code>octocat, jane@acme.com, Jane Developer</code>
                </span>
              </label>
              <label className="opt-check">
                <input
                  type="checkbox"
                  checked={deepScan}
                  onChange={(e) => setDeepScan(e.target.checked)}
                  disabled={scanning}
                />
                <span>
                  <strong>Deep scan</strong> — look up public profiles + Gravatar
                  <span className="opt-note">
                    uses ~1 extra GitHub request per contributor
                  </span>
                </span>
              </label>
            </div>
          )}
        </form>

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
                <button
                  key={r}
                  className="chip chip-example"
                  onClick={() => scanRepo(r)}
                >
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
              <span className="repo-name">
                {result.repoFullName}
                {result.deepScan && <span className="deep-tag">deep</span>}
              </span>
              <button
                className="rescan-btn"
                onClick={() => scanRepo(result.repoFullName)}
                disabled={scanning}
                title="Re-run scan"
              >
                ↻ rescan
              </button>
            </div>

            <div className="summary">
              <div className="summary-stat">
                <div className="stat-value">{result.identities.length}</div>
                <div className="stat-label">People</div>
              </div>
              <div className="summary-stat">
                <div
                  className={`stat-value ${result.highCount > 0 ? "text-exposed" : ""}`}
                >
                  {result.highCount}
                </div>
                <div className="stat-label">High risk</div>
              </div>
              <div className="summary-stat">
                <div
                  className={`stat-value ${
                    result.safeCount === result.identities.length &&
                    result.identities.length > 0
                      ? "text-safe"
                      : ""
                  }`}
                >
                  {result.safeCount}
                </div>
                <div className="stat-label">Safe</div>
              </div>
            </div>

            {result.hiddenHistory && (
              <div className="hidden-history">
                <strong>Hidden history.</strong> Recent commits use a private
                noreply address, but older commits in this repo still expose a
                personal email. Privacy was enabled without rewriting history.
              </div>
            )}

            {result.identities.length > 0 && result.highCount === 0 && (
              <div className="all-clear">
                No high-risk exposure in the sampled commits.
                {result.mediumCount > 0 &&
                  ` ${result.mediumCount} identit${result.mediumCount === 1 ? "y has" : "ies have"} names or profile info public.`}
              </div>
            )}

            {result.identities.length > 0 && (
              <>
                <p className="section-label">Identities</p>
                <div className="person-list">
                  {result.identities.map((id, i) => {
                    const isRevealed = revealed.has(id.key);
                    const personal =
                      !id.isNoreply ||
                      !!(id.publicEmail && !isGitHubNoreply(id.publicEmail));
                    const shown = shownEmailFor(id, isRevealed);
                    const copyable = !id.isNoreply
                      ? id.email
                      : id.publicEmail || id.email;
                    return (
                      <div
                        key={id.key}
                        className={`person-card sev-${id.severity}`}
                        style={{ animationDelay: `${i * 60}ms` }}
                      >
                        <div className="person-head">
                          {id.avatarUrl ? (
                            <img
                              className="avatar"
                              src={id.avatarUrl}
                              alt=""
                              loading="lazy"
                            />
                          ) : (
                            <div className="avatar avatar-fallback">
                              {(id.names[0] || id.email)[0]?.toUpperCase()}
                            </div>
                          )}
                          <div className="person-id">
                            <div className="person-name-row">
                              <span className="person-name">
                                {id.names[0] || id.email.split("@")[0]}
                              </span>
                              {id.isYou && <span className="you-badge">you</span>}
                              <span className={`sev-badge sev-${id.severity}`}>
                                {id.severity}
                              </span>
                            </div>
                            <div className="person-email">
                              <span className="email-address">{shown}</span>
                              {personal && (
                                <span className="email-actions">
                                  <button
                                    className="mini-btn"
                                    onClick={() => toggleReveal(id.key)}
                                    title={isRevealed ? "Hide" : "Reveal"}
                                  >
                                    {isRevealed ? "hide" : "reveal"}
                                  </button>
                                  <button
                                    className="mini-btn"
                                    onClick={() => handleCopyEmail(copyable)}
                                    title="Copy email"
                                  >
                                    {copiedEmail === copyable ? "copied" : "copy"}
                                  </button>
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {id.types.length > 0 && (
                          <div className="etypes">
                            {id.types.map((t) => {
                              const fromProfile = PROFILE_TYPES.has(t);
                              return (
                                <span
                                  key={t}
                                  className={`etype et-${t}`}
                                  title={
                                    fromProfile
                                      ? "From the contributor's public GitHub profile — not the repo"
                                      : "In the repo's commit data"
                                  }
                                >
                                  {TYPE_LABELS[t]}
                                  {fromProfile && (
                                    <span className="etype-src">profile</span>
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        )}

                        <div className="person-meta">
                          <span>{id.roles.join(" + ")}</span>
                          <span className="dot-sep">·</span>
                          <span>
                            {id.commitCount} commit
                            {id.commitCount === 1 ? "" : "s"}
                          </span>
                          {id.login && (
                            <>
                              <span className="dot-sep">·</span>
                              <span>@{id.login}</span>
                            </>
                          )}
                        </div>

                        {id.profile &&
                          (id.profile.location ||
                            id.profile.company ||
                            id.profile.twitter) && (
                            <div className="profile-line">
                              {id.profile.location && (
                                <span>📍 {id.profile.location}</span>
                              )}
                              {id.profile.company && (
                                <span>🏢 {id.profile.company}</span>
                              )}
                              {id.profile.twitter && (
                                <span>✱ @{id.profile.twitter}</span>
                              )}
                            </div>
                          )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {result.identities.length === 0 && (
              <div className="no-emails">
                No committer identities detected in the {result.commitsScanned}{" "}
                sampled commit{result.commitsScanned > 1 ? "s" : ""}.
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

            {result.highCount > 0 && (
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
                    Old commits still contain the exposed data. Use{" "}
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
        Scans public repos via the GitHub REST API (and, on deep scan, Gravatar).
        Nothing is stored; the report masks emails by default.
        <br />
        Unauthenticated rate limit: 60 requests/hour per IP.
      </footer>
    </div>
  );
}
