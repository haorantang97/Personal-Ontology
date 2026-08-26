# Security policy

## Supported versions

Security fixes target the latest released minor version.

## Reporting a vulnerability

Use GitHub's private security-advisory flow when available. Otherwise open a minimal issue asking for a private contact channel; do not include credentials, private knowledge, personal paths, database contents, or exploit payloads in a public issue.

## Trust boundary

Lab Trust Core is deterministic policy software, not a truth oracle. It evaluates declared metadata and cannot establish whether that metadata is honest.

The MCP server is read-only. Payload input is enabled by default. File input is disabled unless `LAB_TRUST_ALLOWED_ROOTS` is set; allowed paths are canonicalized before access to prevent traversal and symlink escapes. The server exposes no storage, shell, Git, approval, database, index, or network tools.
