import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { Socket } from 'node:net';

// The local endpoint of every TCP connection this process opens, so the server can recognise a request
// arriving on the other end of one: the model's own tools (`http`, a body's `fetch`, an MCP client) calling
// the UI's endpoints — above all `POST /sessions/:id/prompt`, which would let it answer its own gate prompts.
// Whatever the model reaches the network with in-process ends up in `net`, and `net.client.socket` reports
// each socket before it connects, on every platform. A process matbot starts is not seen here: its
// connections are another process's, and attributing one to its parent is not something node can do.

export interface OwnConnections {
  /** True when the request's peer is a socket this process opened. */
  opened(peer: Socket): boolean;
  stop(): void;
}

function endpoint(address: string | undefined, port: number | undefined): string | undefined {
  if (address === undefined || port === undefined) return undefined;
  return `${address.startsWith('::ffff:') ? address.slice(7) : address}|${port}`;
}

export function trackOwnConnections(): OwnConnections {
  const open = new Set<string>();
  const onSocket = (message: unknown): void => {
    const socket = (message as { socket: Socket }).socket;
    // Its local port exists only once connected; the request it carries is read after that, being bytes the
    // client could not have sent before.
    socket.once('connect', () => {
      const key = endpoint(socket.localAddress, socket.localPort);
      if (key === undefined) return;
      open.add(key);
      socket.once('close', () => open.delete(key));
    });
  };
  subscribe('net.client.socket', onSocket);
  return {
    opened: (peer) => {
      const key = endpoint(peer.remoteAddress, peer.remotePort);
      return key !== undefined && open.has(key);
    },
    stop: () => { unsubscribe('net.client.socket', onSocket); open.clear(); },
  };
}
