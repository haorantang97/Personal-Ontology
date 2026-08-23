# Third-Party Notices

This module vendors no third-party source or binary. `vault/ops/gateway/package.json` declares two npm dependencies that `npm ci` installs into the user's environment; everything else is software supplied separately by the user.

## @modelcontextprotocol/sdk

The official Model Context Protocol TypeScript SDK, used to expose the gateway as a stdio MCP server. MIT License.

Repository: <https://github.com/modelcontextprotocol/typescript-sdk>

## zod

Schema validation for tool inputs. MIT License.

Repository: <https://github.com/colinhacks/zod>

## Node.js

The gateway and all `ops/*.mjs` scripts run on Node.js, distributed under the MIT License with additional component notices. Not bundled.

Official license: <https://github.com/nodejs/node/blob/main/LICENSE>

## GBrain (external CLI)

The derived index layer. The gateway shells out to a separately installed `gbrain` binary (`status`, `sync`, `call`, `schema validate` / `lint`). `ops/ensure-gbrain-sync-filter.mjs` inspects — and, only with `--apply`, patches — the installed GBrain import walker; review GBrain's license before applying. Not bundled.

Repository: <https://github.com/garrytan/gbrain>

## Ollama (external service)

Local embedding service used by GBrain. `knowledge_repair_index` may start the Ollama desktop app on macOS. Not bundled.

Official site: <https://ollama.com>

## Obsidian

`vault/.obsidian/` contains only this vault's settings files. Obsidian itself is proprietary software under its own terms and is not bundled.

Official site: <https://obsidian.md>
