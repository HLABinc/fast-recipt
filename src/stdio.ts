// Claude Desktop / Claude Code / Codex 向け(ローカル stdio)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";

await createServer().connect(new StdioServerTransport());
