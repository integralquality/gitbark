// gitbark CLI — scan a local git repo's history for exposed personal data.
// Exit codes: 0 = clean (or below fail threshold), 1 = exposure found, 2 = usage/error.

import { readCommits, isGitRepo } from "./git.js";
import { analyzeCommits } from "./core.js";
import { formatReport, emitAnnotations, writeStepSummary } from "./report.js";

const HELP = `gitbark — scan a git repo's commit history for exposed personal data

Usage:
  gitbark [options]

Options:
  --path <dir>        Repository to scan (default: current directory)
  --since <ref>       Only scan commits after <ref>, e.g. origin/main (default: all history)
  --max <n>           Cap the number of commits scanned
  --fail-on <level>   Exit non-zero on: high | medium | never (default: high)
  --allow <entry>     Ignore an email or *@domain (repeatable; also GITBARK_ALLOW env)
  --format <fmt>      Output format: pretty | json (default: pretty)
  -h, --help          Show this help
  -v, --version       Show version

Examples:
  gitbark
  gitbark --since origin/main --fail-on high
  gitbark --allow "*@users.noreply.github.com" --allow me@work.com
`;

const VERSION = "1.0.0";

function parseArgs(argv) {
  const opts = {
    path: ".",
    since: undefined,
    max: undefined,
    failOn: "high",
    format: "pretty",
    allow: [],
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--path": opts.path = next(); break;
      case "--since": opts.since = next(); break;
      case "--max": opts.max = parseInt(next(), 10) || undefined; break;
      case "--fail-on": opts.failOn = next(); break;
      case "--format": opts.format = next(); break;
      case "--allow": opts.allow.push(next()); break;
      case "-h": case "--help": opts.help = true; break;
      case "-v": case "--version": opts.version = true; break;
      default:
        if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
    }
  }
  return opts;
}

function collectAllow(cliAllow) {
  const fromEnv = (process.env.GITBARK_ALLOW || "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...cliAllow, ...fromEnv];
}

const shouldFail = {
  high: (r) => r.highCount > 0,
  medium: (r) => r.highCount + r.mediumCount > 0,
  never: () => false,
};

export function run(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${HELP}`);
    return 2;
  }

  if (opts.help) { process.stdout.write(HELP); return 0; }
  if (opts.version) { process.stdout.write(`${VERSION}\n`); return 0; }
  if (!shouldFail[opts.failOn]) {
    process.stderr.write(`Invalid --fail-on "${opts.failOn}" (use high | medium | never).\n`);
    return 2;
  }

  if (!isGitRepo(opts.path)) {
    process.stderr.write(`Not a git repository: ${opts.path}\n`);
    return 2;
  }

  let result;
  try {
    const commits = readCommits({ cwd: opts.path, since: opts.since, max: opts.max });
    result = analyzeCommits(commits, { allow: collectAllow(opts.allow) });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }

  const inActions = process.env.GITHUB_ACTIONS === "true";

  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(formatReport(result, { repo: opts.path }) + "\n");
  }

  if (inActions) {
    emitAnnotations(result);
    writeStepSummary(result, { repo: opts.path });
  }

  return shouldFail[opts.failOn](result) ? 1 : 0;
}
