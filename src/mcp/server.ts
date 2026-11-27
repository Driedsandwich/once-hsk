import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { PayOnceApi } from '../types.js';

const hex = z.string().refine((s): s is `0x${string}` => /^0x[0-9a-fA-F]+$/.test(s), 'Expected 0x-prefixed hex');
const terms = z.object({
  sellerAgentId: z.string(),
  payTo: hex,
  amountUsd: z.string(),
  item: z.string(),
  itemVersionHash: hex,
  expiresAt: z.string(),
  whatYouLearn: z.string()
});

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function createMcpServer(api: PayOnceApi) {
  const server = new McpServer({ name: 'once-payments', version: '0.1.0' });
  server.registerTool('pay_once', {
    description: 'Pay for an order using PayIntent. Human approval is required before the payment is sent.',
    inputSchema: { buyerAgentId: z.string(), terms, intentNonce: z.string() }
  }, async intent => result(await api.payOnce(intent)));
  server.registerTool('get_payment', {
    description: 'Look up a payment by requestId. Returns null if unknown.',
    inputSchema: { requestId: hex },
    annotations: { readOnlyHint: true }
  }, async ({ requestId }) => result((await api.get(requestId)) ?? null));
  server.registerTool('resume_pending', {
    description: 'Ask the payment engine to resume pending orders under its approval rules.',
    inputSchema: {}
  }, async () => result(await api.resumeAll()));
  return server;
}

export async function startStdio(api: PayOnceApi) {
  const server = createMcpServer(api);
  await server.connect(new StdioServerTransport());
  return server;
}

export function createMcpHttpServer(api: PayOnceApi) {
  return createServer(async (req, res) => {
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    const hosts = ['127.0.0.1', 'localhost', '[::1]'].map(host => `${host}:${req.socket.localPort}`);
    if (!hosts.includes(req.headers.host ?? '') ||
        (req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host}`)) {
      res.writeHead(403).end();
      return;
    }
    const server = createMcpServer(api);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.once('close', () => { void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' }
        }));
      } else res.end();
    }
  });
}
