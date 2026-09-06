# Third-Party Notices

This module vendors no third-party source or binary. `vault/ops/gateway/package.json` and its lockfile declare the packages installed by `npm ci`; external applications remain separately supplied by the user.

## @modelcontextprotocol/sdk

The official Model Context Protocol TypeScript SDK, used to expose the gateway as a stdio MCP server. MIT License.

Repository: <https://github.com/modelcontextprotocol/typescript-sdk>

## zod

Schema validation for tool inputs. MIT License.

Repository: <https://github.com/colinhacks/zod>

## Lab Trust Core

The gateway pins the separately published `lab-trust-core` release archive and uses it for non-enforcing trust shadow observations after an allowed page read. MIT License.

Repository: <https://github.com/haorantang97/Personal-Ontology/tree/main/lab-trust-core>

## Node.js

The gateway and all `ops/*.mjs` scripts run on Node.js, distributed under the MIT License with additional component notices. Not bundled.

Official license: <https://github.com/nodejs/node/blob/main/LICENSE>

## Ollama (reference external service)

The Native index speaks an Ollama-compatible `/api/tags` and `/api/embed` HTTP contract. Ollama is the reference local embedding service for optional manual runtime integration checks; it is not bundled or started by this module.

Official site: <https://ollama.com>

## Obsidian

`vault/.obsidian/` contains only this vault's settings files. Obsidian itself is proprietary software under its own terms and is not bundled.

Official site: <https://obsidian.md>
