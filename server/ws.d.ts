// Minimal typings for the parts of the `ws` package the server uses.
declare module 'ws' {
  import type { IncomingMessage, Server as HttpServer } from 'node:http';
  import type { EventEmitter } from 'node:events';

  export class WebSocket extends EventEmitter {
    static readonly OPEN: number;
    readonly readyState: number;
    readonly bufferedAmount: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    ping(): void;
    on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): this;
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
    on(event: 'pong', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
  }

  export class WebSocketServer extends EventEmitter {
    constructor(opts: { server: HttpServer; path?: string; maxPayload?: number });
    on(event: 'connection', listener: (ws: WebSocket, req: IncomingMessage) => void): this;
  }
}
