import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it, vi } from 'vitest';
import { zeroHash } from 'viem';
import { createMcpHttpServer } from '../src/mcp/server.js';
import { intent, payOnceApi, record } from './support/fixtures.js';
import { close, listen } from './support/http.js';

function client() {
  return new Client({ name: 'research-agent-test', version: '1.0.0' });
}
async function checkTools(c: Client) {
  const { tools } = await c.listTools();
  expect(tools.map(t => t.name).sort()).toEqual(['get_payment', 'pay_once', 'resume_pending']);
  expect(tools.find(t => t.name === 'pay_once')?.description).toContain('Human approval is required before the payment is sent');
  async function call(name: string, args: Record<string, unknown>, expected: unknown) {
    const result = await c.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(expected) }]);
  }
  await call('pay_once', { ...intent }, record);
  await call('get_payment', { requestId: record.requestId }, record);
  await call('get_payment', { requestId: zeroHash }, null);
  await call('resume_pending', {}, [record]);
}

describe('MCP SDK client and server', () => {
  it('dispatches each Streamable HTTP tool to the injected API with the original arguments', async () => {
    const api = { payOnce: vi.fn(payOnceApi.payOnce), get: vi.fn(payOnceApi.get), resumeAll: vi.fn(payOnceApi.resumeAll) };
    const server = createMcpHttpServer(api);
    const url = new URL('/mcp', await listen(server));
    const c = client();
    try {
      await c.connect(new StreamableHTTPClientTransport(url));
      await checkTools(c);
      expect(api.payOnce.mock.calls).toEqual([[intent]]);
      expect(api.get.mock.calls).toEqual([[record.requestId], [zeroHash]]);
      expect(api.resumeAll.mock.calls).toEqual([[]]);
    } finally { await c.close(); await close(server); }
  });

  it('runs all three tools over stdin/stdout through the adapter-loading CLI', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp/cli.ts', 'stdio'],
      env: { TMPDIR: tmpdir(), ONCE_API_MODULE: resolve('test/support/fixtures.ts') }
    });
    const c = client();
    try { await c.connect(transport); await checkTools(c); }
    finally { await c.close(); }
  });
});
