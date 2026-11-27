import { defineConfig } from 'vitest/config';

// The stdio MCP test starts a child `node --import tsx`; under a parallel run that start-up can pass 5 s.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 }
});
