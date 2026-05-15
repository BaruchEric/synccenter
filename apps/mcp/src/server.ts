import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ApiClient } from "./api.ts";
import { TOOLS, requireConfirm, type ToolDef } from "./tools.ts";

export interface ServerDeps {
  api: ApiClient;
}

export function buildMcpServer({ api }: ServerDeps): Server {
  const server = new Server(
    { name: "synccenter", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: "object" },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool: ToolDef | undefined = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return errorContent(`unknown tool: ${name}`);
    }
    try {
      requireConfirm(tool, args ?? {});
      const result = await tool.handler(args ?? {}, api);
      return {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return errorContent(err instanceof Error ? err.message : String(err));
    }
  });

  return server;
}

function errorContent(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `error: ${message}` }],
  };
}
