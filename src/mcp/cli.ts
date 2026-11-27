import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMcpHttpServer, startStdio } from './server.js';
import type { PayOnceApi } from '../types.js';

const adapter = process.env.ONCE_API_MODULE;
if (!adapter) throw new Error('Set ONCE_API_MODULE to a module exporting payOnceApi.');
const { payOnceApi: api } = await import(pathToFileURL(resolve(adapter)).href) as { payOnceApi?: PayOnceApi };
if (!api || [api.payOnce, api.get, api.resumeAll].some(method => typeof method !== 'function')) {
  throw new Error('The adapter must export payOnceApi with payOnce, get and resumeAll.');
}
switch (process.argv[2] ?? 'stdio') {
  case 'stdio':
    await startStdio(api);
    break;
  case 'http': {
    const port = Number(process.env.PORT ?? '3002');
    createMcpHttpServer(api).listen(port, '127.0.0.1', () => {
      console.error(`Once MCP listening on http://127.0.0.1:${port}/mcp`);
    });
    break;
  }
  default: throw new Error('Use stdio or http.');
}
