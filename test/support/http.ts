import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

export async function close(server: Server) {
  const closed = new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  server.closeAllConnections();
  await closed;
}
