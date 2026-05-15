#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiClient } from "./api.ts";
import { buildMcpServer } from "./server.ts";

const baseUrl = process.env.SC_API_URL;
if (!baseUrl) {
  process.stderr.write("error: SC_API_URL is required\n");
  process.exit(2);
}
const token = process.env.SC_MCP_TOKEN ?? process.env.SC_API_TOKEN;
if (!token) {
  process.stderr.write("error: SC_MCP_TOKEN (or SC_API_TOKEN) is required\n");
  process.exit(2);
}

const api = new ApiClient({ baseUrl, token });
const server = buildMcpServer({ api });
const transport = new StdioServerTransport();
await server.connect(transport);
