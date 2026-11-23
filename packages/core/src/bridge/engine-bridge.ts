import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { NexusError, type ProtocolErrorDetail } from "../errors/index.js";

export const PROTOCOL_VERSION = 1;
export const CLIENT_VERSION = "0.1.0";

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (err: NexusError) => void;
  timer: NodeJS.Timeout;
}

export interface BridgeOptions {
  binaryPath?: string;
  defaultTimeoutMs?: number;
  maxRestarts?: number;
  onLog?: (line: string) => void;
}

export class EngineBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private reqCounter = 0;
  private shuttingDown = false;
  private restartCount = 0;
  private readonly maxRestarts: number;
  private readonly defaultTimeoutMs: number;
  private readonly binaryPath: string;
  private readonly onLog?: (line: string) => void;
  private lastInitReplay?: () => Promise<void>;

  constructor(opts: BridgeOptions = {}) {
    this.binaryPath = opts.binaryPath ?? EngineBridge.resolveDefaultBinaryPath();
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 15_000;
    this.maxRestarts = opts.maxRestarts ?? 3;
    this.onLog = opts.onLog;
  }

  static resolveDefaultBinaryPath(): string {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      process.env.NEXUS_ENGINE_PATH,
      path.resolve(process.cwd(), "packages/core/bin/nexus-engine.exe"),
      path.resolve(process.cwd(), "packages/core/bin/nexus-engine"),
      path.resolve(currentDir, "../../bin/nexus-engine.exe"),
      path.resolve(currentDir, "../../bin/nexus-engine"),
    ].filter((c): c is string => Boolean(c));

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return candidates[0] ?? path.resolve(process.cwd(), "packages/core/bin/nexus-engine");
  }

  public setReplayHook(hook: () => Promise<void>): void {
    this.lastInitReplay = hook;
  }

  public async start(): Promise<void> {
    if (this.proc) return;
    if (!fs.existsSync(this.binaryPath)) {
      throw new NexusError({
        code: "NEXUS_ENGINE_CRASHED",
        message: `Nexus Go engine binary not found at ${this.binaryPath}. Run 'npm run build:go' first.`,
        retryable: false,
      });
    }

    this.shuttingDown = false;
    const child = spawn(this.binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = child;

    const rlOut = readline.createInterface({ input: child.stdout });
    rlOut.on("line", (line) => this.handleStdoutLine(line));

    const rlErr = readline.createInterface({ input: child.stderr });
    rlErr.on("line", (line) => {
      if (this.onLog) {
        this.onLog(line);
      }
    });

    child.on("exit", (code, signal) => {
      this.proc = null;
      const crashErr = new NexusError({
        code: "NEXUS_ENGINE_CRASHED",
        message: `Nexus Go engine exited unexpectedly (code=${code}, signal=${signal})`,
        retryable: true,
      });

      for (const [id, pendingReq] of this.pending.entries()) {
        clearTimeout(pendingReq.timer);
        pendingReq.reject(crashErr);
        this.pending.delete(id);
      }

      if (!this.shuttingDown && this.restartCount < this.maxRestarts) {
        this.restartCount++;
        void this.start().then(async () => {
          if (this.lastInitReplay) {
            await this.lastInitReplay();
          }
        });
      }
    });

    const hs = await this.request<{ engineVersion: string; protocolVersion: number }>(
      "engine.handshake",
      {
        clientVersion: CLIENT_VERSION,
        protocolVersion: PROTOCOL_VERSION,
      }
    );

    if (hs.protocolVersion !== PROTOCOL_VERSION) {
      throw new NexusError({
        code: "NEXUS_VERSION_MISMATCH",
        message: `Protocol version mismatch between Node client (${PROTOCOL_VERSION}) and Go engine (${hs.protocolVersion})`,
        retryable: false,
      });
    }
    this.restartCount = 0;
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: {
      v: number;
      id: string;
      ok: boolean;
      result?: unknown;
      error?: ProtocolErrorDetail;
    };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    const pendingReq = this.pending.get(parsed.id);
    if (!pendingReq) return;
    clearTimeout(pendingReq.timer);
    this.pending.delete(parsed.id);

    if (parsed.ok) {
      pendingReq.resolve(parsed.result);
    } else {
      pendingReq.reject(
        NexusError.fromProtocol(
          parsed.error ?? {
            code: "NEXUS_INTERNAL_ERROR",
            message: "Unknown engine error",
            retryable: false,
          }
        )
      );
    }
  }

  public async request<TResult = any>(
    method: string,
    params: unknown = {},
    timeoutMs: number = this.defaultTimeoutMs
  ): Promise<TResult> {
    if (!this.proc && method !== "engine.handshake") {
      await this.start();
    }
    if (!this.proc) {
      throw new NexusError({
        code: "NEXUS_ENGINE_CRASHED",
        message: "Nexus Go engine is not running",
        retryable: true,
      });
    }

    const id = `req_${++this.reqCounter}_${Date.now()}`;
    const payload =
      JSON.stringify({
        v: PROTOCOL_VERSION,
        id,
        method,
        timeoutMs,
        params,
      }) + "\n";

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new NexusError({
            code: "NEXUS_TIMEOUT",
            message: `Engine request '${method}' timed out after ${timeoutMs}ms`,
            retryable: true,
          })
        );
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(
            new NexusError({
              code: "NEXUS_ENGINE_CRASHED",
              message: `Failed writing to Go engine stdin: ${err.message}`,
              retryable: true,
            })
          );
        }
      });
    });
  }

  public async stop(): Promise<void> {
    this.shuttingDown = true;
    if (!this.proc) return;
    try {
      await this.request("engine.shutdown", {}, 2000);
    } catch {
      // process may already have exited
    } finally {
      if (this.proc) {
        this.proc.kill("SIGTERM");
        this.proc = null;
      }
    }
  }
}
