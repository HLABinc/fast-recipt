// ChatGPT / claude.ai 向け(Streamable HTTP, ステートレス)。HTTPS 公開はトンネルやホスティングで行う。
import { createServer as createHttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, loadSchema } from "./server.ts";

const schema = loadSchema();
const port = Number(process.env.PORT ?? 8787);

createHttpServer(async (req, res) => {
  if (req.url !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" }).end();
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.writeHead(400).end("invalid JSON");
    return;
  }

  const server = createServer(schema);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}).listen(port, () => console.error(`fast-receipt MCP: http://localhost:${port}/mcp`));
