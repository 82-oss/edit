// The bad line: every connection from Edit to the stand-ins passes through
// here (Edit is given this port, never the stand-ins' own). It can slow each
// direction, add delay, drop every connection, go silent, or cut a
// connection after so many bytes. Shaping the line with the system's tools
// needs root; a program doesn't, and proves the same.
//
// It runs in inside.ts's process, never in Edit's process group, so a freeze
// of Edit leaves it answering (and cut, as a Mac's Wi-Fi is while it sleeps).
//
// It holds at most a little of each connection (it stops reading the far side
// past HIGH bytes queued), so a slow line is slow end to end, and it counts
// the bytes it hands Edit by the request they answer (read from each request
// line on the way in): what Edit really fetched, not what a stand-in sent.

import * as net from "node:net";

export type LineState =
  /** Bytes pass (at the rates set). */
  | "up"
  /** Every connection is dropped and new ones are refused at once (a reset). */
  | "down"
  /** Connections are taken and held, but nothing passes either way (Wi-Fi with no internet). */
  | "silent";

export interface Shape {
  /** Bytes a second toward Edit (0: as fast as it goes). */
  down: number;
  /** Bytes a second from Edit. */
  up: number;
  /** Added to each chunk, each way (ms). */
  delayMs: number;
  /** A connection is closed after this many bytes toward Edit (0: never), counted per connection from when it's set. */
  cutAfter: number;
}

interface Pipe {
  id: number;
  client: net.Socket;
  server: net.Socket;
  toServer: Buffer[];
  toClient: Buffer[];
  queuedServer: number;
  queuedClient: number;
  sentDown: number;
  /** The path of the request the bytes toward Edit answer now. */
  path: string;
  request: { bytes: number } | null;
  closed: boolean;
  /** The stand-in ended its side: what's queued still goes to Edit, then this closes. */
  closing: boolean;
}

const HIGH = 64 * 1024;
const LOW = 16 * 1024;
const REQUEST = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\/\S*) HTTP\/1\.[01]\r\n/;

export class Line {
  state: LineState = "up";
  shape: Shape = { down: 0, up: 0, delayMs: 0, cutAfter: 0 };
  /** Bytes that crossed toward Edit and from it, all connections. */
  bytesDown = 0;
  bytesUp = 0;
  connections = 0;
  /** Bytes handed to Edit, by the path (no query) of the request they answered. */
  readonly byPath = new Map<string, number>();
  /** Every request seen on the way in, and the bytes handed back for it. */
  readonly requests: { at: number; pipe: number; line: string; range: string; bytes: number }[] = [];
  private pipes = new Set<Pipe>();
  private server: net.Server | null = null;
  private nextId = 1;
  private ticker: ReturnType<typeof setInterval>;
  private allowDown = 0;
  private allowUp = 0;
  private readonly tickMs = 20;

  constructor(
    private readonly target: number,
    private readonly log: (line: string) => void = () => {},
  ) {
    this.ticker = setInterval(() => this.tick(), this.tickMs);
  }

  /** Listens on a port of its own; Edit is given `http://127.0.0.1:<port>`. */
  async start(): Promise<number> {
    this.server = net.createServer((client) => this.open(client));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return this.port;
  }

  get port(): number {
    const address = this.server?.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }

  /** Bytes handed to Edit for requests whose path starts with `prefix`. */
  sent(prefix: string): number {
    let sum = 0;
    for (const [path, bytes] of this.byPath) if (path.startsWith(prefix)) sum += bytes;
    return sum;
  }

  set(state: LineState): void {
    if (state === this.state) return;
    this.log(`line ${this.state} → ${state}`);
    this.state = state;
    if (state === "down") for (const pipe of [...this.pipes]) this.close(pipe);
    if (state === "up") for (const pipe of this.pipes) this.flush(pipe);
  }

  /** Changes the shape; unset fields keep theirs. */
  reshape(shape: Partial<Shape>): void {
    this.shape = { ...this.shape, ...shape };
    if (shape.cutAfter !== undefined) for (const pipe of this.pipes) pipe.sentDown = 0;
    this.log(`line shape ${JSON.stringify(this.shape)}`);
  }

  /** Back to a clean, fast line. */
  clear(): void {
    this.shape = { down: 0, up: 0, delayMs: 0, cutAfter: 0 };
    this.set("up");
  }

  stop(): void {
    clearInterval(this.ticker);
    for (const pipe of [...this.pipes]) this.close(pipe);
    this.server?.close();
  }

  private open(client: net.Socket): void {
    this.connections += 1;
    if (this.state === "down") {
      client.resetAndDestroy();
      return;
    }
    const server = net.connect(this.target, "127.0.0.1");
    const pipe: Pipe = { id: this.nextId++, client, server, toServer: [], toClient: [], queuedServer: 0, queuedClient: 0, sentDown: 0, path: "", request: null, closed: false, closing: false };
    this.pipes.add(pipe);
    client.on("data", (data: Buffer) => {
      const request = REQUEST.exec(data.toString("latin1", 0, Math.min(data.length, 2048)));
      if (request !== null) {
        const head = data.toString("latin1", 0, Math.min(data.length, 4096));
        const entry = { at: Date.now(), pipe: pipe.id, line: `${request[1]} ${request[2]!.split("?")[0]}`, range: /\r\nrange: *([^\r]*)/i.exec(head)?.[1] ?? "", bytes: 0 };
        this.requests.push(entry);
        pipe.request = entry;
        try {
          pipe.path = decodeURIComponent(request[2]!.split("?")[0]!);
        } catch {
          pipe.path = request[2]!.split("?")[0]!;
        }
      }
      this.queue(pipe, "toServer", data);
    });
    server.on("data", (data: Buffer) => this.queue(pipe, "toClient", data));
    client.on("drain", () => this.flush(pipe));
    server.on("drain", () => this.flush(pipe));
    client.on("end", () => this.close(pipe));
    server.on("end", () => {
      pipe.closing = true;
      this.flush(pipe);
    });
    client.on("error", () => this.close(pipe));
    client.on("close", () => this.close(pipe));
    server.on("error", () => this.close(pipe));
    server.on("close", () => {
      pipe.closing = true;
      this.flush(pipe);
    });
  }

  private queue(pipe: Pipe, way: "toServer" | "toClient", data: Buffer): void {
    if (pipe.closed) return;
    const add = () => {
      if (pipe.closed) return;
      pipe[way].push(data);
      if (way === "toServer") pipe.queuedServer += data.length;
      else pipe.queuedClient += data.length;
      // Holds at most HIGH bytes of a connection: the far side waits.
      if ((way === "toServer" ? pipe.queuedServer : pipe.queuedClient) > HIGH) (way === "toServer" ? pipe.client : pipe.server).pause();
      this.flush(pipe);
    };
    if (this.shape.delayMs > 0) setTimeout(add, this.shape.delayMs);
    else add();
  }

  private tick(): void {
    const { down, up } = this.shape;
    // A bucket holds at most a quarter second's bytes, so a pause doesn't bank a burst.
    if (down > 0) this.allowDown = Math.min(this.allowDown + (down * this.tickMs) / 1000, Math.max(down / 4, 1500));
    if (up > 0) this.allowUp = Math.min(this.allowUp + (up * this.tickMs) / 1000, Math.max(up / 4, 1500));
    for (const pipe of this.pipes) this.flush(pipe);
  }

  private flush(pipe: Pipe): void {
    if (pipe.closed || this.state !== "up") return;
    this.move(pipe, "toServer");
    this.move(pipe, "toClient");
    if (pipe.closing && pipe.toClient.length === 0) this.close(pipe);
  }

  private move(pipe: Pipe, way: "toServer" | "toClient"): void {
    const to = way === "toServer" ? pipe.server : pipe.client;
    if (to.destroyed || to.writableNeedDrain || (way === "toServer" && to.connecting)) return;
    const queue = pipe[way];
    const rate = way === "toServer" ? this.shape.up : this.shape.down;
    while (queue.length > 0 && !to.writableNeedDrain) {
      let chunk = queue[0]!;
      let allow = rate > 0 ? Math.floor(way === "toServer" ? this.allowUp : this.allowDown) : chunk.length;
      if (way === "toClient" && this.shape.cutAfter > 0) {
        if (pipe.sentDown >= this.shape.cutAfter) {
          this.log(`line cut connection ${pipe.id} after ${pipe.sentDown} bytes`);
          this.close(pipe);
          return;
        }
        allow = Math.min(allow, this.shape.cutAfter - pipe.sentDown);
      }
      if (allow <= 0) return;
      if (chunk.length > allow) {
        queue[0] = chunk.subarray(allow);
        chunk = chunk.subarray(0, allow);
      } else {
        queue.shift();
      }
      to.write(chunk);
      if (way === "toServer") {
        this.bytesUp += chunk.length;
        pipe.queuedServer -= chunk.length;
        if (rate > 0) this.allowUp -= chunk.length;
        if (pipe.queuedServer < LOW) pipe.client.resume();
      } else {
        this.bytesDown += chunk.length;
        pipe.sentDown += chunk.length;
        pipe.queuedClient -= chunk.length;
        this.byPath.set(pipe.path, (this.byPath.get(pipe.path) ?? 0) + chunk.length);
        if (pipe.request !== null) pipe.request.bytes += chunk.length;
        if (rate > 0) this.allowDown -= chunk.length;
        if (pipe.queuedClient < LOW) pipe.server.resume();
      }
    }
  }

  private close(pipe: Pipe): void {
    if (pipe.closed) return;
    pipe.closed = true;
    this.pipes.delete(pipe);
    pipe.client.destroy();
    pipe.server.destroy();
  }
}
