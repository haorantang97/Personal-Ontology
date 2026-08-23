# Legal and Connector Boundary

This page is an engineering risk boundary, not legal advice. Qualified counsel must review the package, target jurisdictions, platform terms, and the final publication plan.

## Why native key extraction is excluded

GitHub's public DMCA repository contains July 2026 notices submitted on Tencent's behalf concerning WeChat 4.x tools. The notices allege unlawful circumvention and terms violations involving database-key extraction, process-memory techniques, unique key derivation/memory layouts, and proprietary database design. Relevant primary records include:

- <https://github.com/github/dmca/blob/master/2026/07/2026-07-13-wechat-3.md>
- <https://github.com/github/dmca/blob/master/2026/07/2026-07-27-wechat-4.md>

The notices are allegations by the submitter, not a legal judgment by this project. Their recency and specificity make it inappropriate for a public commercial-rights-reserved package to implement or distribute process-memory scanning, injection, re-signing, proprietary key derivation, or a wrapper that effectively republishes a removed circumvention tool without legal review and platform authorization.

## What this package does allow

- Read directories the user explicitly places in scope.
- Copy source files read-only into an immutable local snapshot.
- Recognize ordinary SQLite versus a conservative encrypted candidate.
- Accept a key the user separately and lawfully obtained, after an exact authorization receipt.
- Invoke a separately installed, generally available SQLCipher binary through its documented interface.
- Inspect a plaintext snapshot and map only an explicitly recognized schema profile.
- Fall back to a user-provided lawful export.

SQLCipher itself is not bundled. Its official licensing page describes community and commercial licensing choices: <https://www.zetetic.net/sqlcipher/license/>. The user must verify the license of the binary they install.

## Publication gate

Before public release, counsel should review at least:

- anti-circumvention law and applicable exceptions in target jurisdictions;
- WeChat/Weixin terms and automated-access restrictions;
- whether the observed-shape schema profiles may be published;
- the custom noncommercial/public-view license and commercial authorization model;
- the final source archive and notices.

Until that review grants a broader boundary, native key extraction remains a blocker, not a roadmap promise and not an undocumented feature.
