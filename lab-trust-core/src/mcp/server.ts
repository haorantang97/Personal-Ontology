#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  TRUST_TOOL_DEFINITIONS,
  createTrustToolHandlers,
  type TrustToolHandlerOptions
} from "./tools.js";

export function createTrustMcpServer(options: TrustToolHandlerOptions = {}): McpServer {
  const server = new McpServer({
    name: "lab-trust-core",
    version: "0.1.0"
  });
  const handlers = createTrustToolHandlers(options);

  server.registerTool(
    "trust_validate",
    {
      description: TRUST_TOOL_DEFINITIONS[0].description,
      inputSchema: {
        record: z.unknown().optional(),
        file: z.string().optional()
      },
      annotations: TRUST_TOOL_DEFINITIONS[0].annotations
    },
    async (input) => await handlers.trust_validate(input)
  );

  server.registerTool(
    "trust_evaluate",
    {
      description: TRUST_TOOL_DEFINITIONS[1].description,
      inputSchema: {
        record: z.unknown().optional(),
        file: z.string().optional(),
        context: z.unknown()
      },
      annotations: TRUST_TOOL_DEFINITIONS[1].annotations
    },
    async (input) => await handlers.trust_evaluate(input)
  );

  server.registerTool(
    "trust_promotion_check",
    {
      description: TRUST_TOOL_DEFINITIONS[2].description,
      inputSchema: {
        record: z.unknown().optional(),
        file: z.string().optional(),
        evidence: z.unknown()
      },
      annotations: TRUST_TOOL_DEFINITIONS[2].annotations
    },
    async (input) => await handlers.trust_promotion_check(input)
  );

  return server;
}

export async function startTrustMcpServer(
  options: TrustToolHandlerOptions = {}
): Promise<void> {
  const server = createTrustMcpServer(options);
  await server.connect(new StdioServerTransport());
}

export * from "./tools.js";

const entry = process.argv[1];
if (entry && pathToFileURL(path.resolve(entry)).href === import.meta.url) {
  await startTrustMcpServer();
}
