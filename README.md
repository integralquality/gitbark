# gitbark

A tool for finding the personal data that public GitHub repos quietly expose. Point it at any public repo and it surfaces the emails, real names, co-author leaks, and public profile info embedded in the commit history.

Every git commit embeds its author's identity (name + email) in metadata that anyone can read on a public repo — just append `.patch` to any commit URL to see it. Most people never realize their personal email is sitting in their public history. gitbark surfaces exactly what's exposed and how to lock it down.

## What it checks

- **Emails** — personal addresses committed to history (vs. GitHub `noreply` addresses, which are safe).
- **Real names** — full names attached to commits.
- **Co-author & sign-off leaks** — identities hidden in `Co-authored-by:` and `Signed-off-by:` commit trailers.
- **Hidden history** — flags repos where recent commits switched to a private noreply address but older commits still leak a real email (privacy enabled without rewriting history).
- **Public profile PII** *(deep scan)* — location, company, and social handles pulled from contributors' GitHub profiles, plus a public **Gravatar** photo linked to a leaked email.

Findings are grouped per person into identity cards and ranked **high / medium / safe**, so you see who's most exposed at a glance.

## How it works

gitbark reads commit **metadata only** — it never fetches diffs or file contents. To stay well within GitHub's unauthenticated rate limit, it **boundary-samples** each repo, pulling the latest, middle, and oldest commits rather than the whole history. That's enough to catch identity leaks across a project's lifetime in just a few requests.

Everything runs client-side in the browser against the public GitHub REST API. Nothing is sent to a server or stored; the exportable report masks emails by default.

## Features

- **Scan a repo** — enter `owner/repo` or a GitHub URL.
- **List an owner's repos** — enter just an `owner` (user or org) to browse their public repos, then **quick-scan** them all for exposed emails at once.
- **Highlight me** — flag your own identity in the results by username, email, or name.
- **Deep scan** — opt in to public-profile + Gravatar lookups (uses a few extra requests).
- **Shareable links** — scans are captured in the URL (`?repo=` / `?owner=`) and recent scans are remembered locally.
- **Exportable report** — copy or download a plain-text summary (emails masked).
- **Fix guide** — step-by-step instructions to enable email privacy and clean up leaked history.

## Tech

React 19 + TypeScript, built with Vite. No backend, no dependencies beyond React — a single-page app talking directly to the GitHub API.

## Development

```bash
npm install
npm run dev      # start the dev server
npm run build    # type-check and build for production
npm run preview  # preview the production build
```

## Limitations

- **Public repos only**, and unauthenticated GitHub access is capped at **60 requests/hour** per IP.
- Boundary sampling can miss leaks in the middle of a large history — it's a fast triage, not an exhaustive audit.
- gitbark reads commit metadata, not file contents, so secrets or PII committed *inside* files aren't detected.
