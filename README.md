# gitbark

Scan a git repository's **commit history** for exposed personal data — personal emails, real names, and identities leaked through `Co-authored-by:` / `Signed-off-by:` trailers — and fail your CI when it finds them.

Every git commit embeds its author's identity (name + email) in metadata that anyone can read on a public repo — just append `.patch` to any commit URL to see it. Most people never realize their personal email is sitting in their public history. gitbark catches that before it ships.

It reads commit **metadata only** (never file contents) straight from local git, so it's fast, needs no API token, and has no rate limit. Zero runtime dependencies.

## Use it in GitHub Actions

Add a workflow. The one thing that matters: **check out full history** with `fetch-depth: 0`, or a shallow clone hides the old commits you're trying to catch.

```yaml
# .github/workflows/gitbark.yml
name: gitbark
on: [pull_request]

jobs:
  pii:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: integralquality/gitbark@v1
        with:
          fail-on: high
```

Findings show up as inline annotations on the PR and in the job summary; a `high` finding fails the check.

### Scan only a PR's new commits

Full-history scans flag pre-existing leaks too. To gate only what a PR *adds*, scan the range against the base branch:

```yaml
      - uses: integralquality/gitbark@v1
        with:
          since: origin/${{ github.base_ref }}
          fail-on: high
```

### Allowlisting

Ignore addresses you accept (bots, noreply, your own domain):

```yaml
      - uses: integralquality/gitbark@v1
        with:
          allow: |
            *@users.noreply.github.com
            ci@yourcompany.com
            *@yourcompany.com
```

### Action inputs

| Input | Default | Description |
|---|---|---|
| `path` | `.` | Directory to scan. |
| `fail-on` | `high` | Severity that fails the job: `high`, `medium`, or `never`. |
| `since` | `""` | Only scan commits after this ref (e.g. `origin/main`). Empty = full history. |
| `allow` | `""` | Emails or `*@domain` patterns to ignore, one per line or comma-separated. |

## Use it as a CLI

No install needed:

```bash
npx gitbark                              # scan the current repo's full history
npx gitbark --since origin/main          # only new commits vs. main
npx gitbark --fail-on medium             # also fail on real-name exposure
npx gitbark --allow "*@users.noreply.github.com" --format json
```

Or install it:

```bash
npm install -g gitbark
gitbark --help
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | No exposure at or above the fail threshold. |
| `1` | Exposure found — fails the build. |
| `2` | Usage error / not a git repo. |

## Use it as a library

The analysis core is pure and dependency-free:

```js
import { analyzeCommits } from "gitbark";

const result = analyzeCommits(commits); // commits: [{ sha, authorName, authorEmail, committerName, committerEmail, message }]
// → { totalCommits, identities, highCount, mediumCount, safeCount, hiddenHistory }
```

## What counts as exposure

| Severity | What it means |
|---|---|
| 🔴 **high** | A personal email is committed to history (author, committer, or a trailer). |
| 🟡 **medium** | A real name is exposed, but no personal email. |
| 🟢 **safe** | Only GitHub `noreply` addresses — nothing personal. |

gitbark also flags **hidden history**: repos where recent commits switched to a private noreply address but older commits still leak a real email (privacy was enabled without rewriting history).

## How to fix exposure

1. GitHub → **Settings → Emails** → enable **"Keep my email addresses private"** and **"Block command line pushes that expose my email"**.
2. Point local git at your noreply address:
   ```bash
   git config --global user.email "ID+USERNAME@users.noreply.github.com"
   ```
3. Old commits still contain the exposed data — rewrite history with [`git filter-repo`](https://github.com/newren/git-filter-repo) or [BFG Repo-Cleaner](https://rtyley.github.io/bfg-repo-cleaner/) if needed.

## Limitations

- Reads commit **metadata**, not file contents — secrets or PII committed *inside* files aren't detected.
- Name/email heuristics are best-effort; use `allow` to quiet known-good addresses.

## Development

```bash
npm test   # runs the unit tests (node --test)
```

The browser UI that this project started as lives on the [`frontend`](https://github.com/integralquality/gitbark/tree/frontend) branch.

MIT licensed.
