import fs from "node:fs";
import path from "node:path";
import { pino, type DestinationStream, type Logger } from "pino";
import { secrets, type SecretRegistry } from "./secrets.js";

export type { Logger };

/** Field names that are always redacted, wherever they appear in a log object. */
const REDACT_PATHS = [
  "secretKey",
  "privateKey",
  "passphrase",
  "password",
  "apiKey",
  "seed",
  "mnemonic",
  "authorization",
  "cookie",
  "keypair",
  "*.secretKey",
  "*.privateKey",
  "*.passphrase",
  "*.password",
  "*.apiKey",
  "*.seed",
  "*.mnemonic",
  "*.authorization",
  "*.cookie",
  "*.keypair",
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
];

/**
 * Size-based rotating file writer. Keeps `maxFiles` rotated files (app.log.1 … app.log.N).
 * Synchronous on purpose: log lines must not be lost on crash.
 */
export class RotatingFileStream implements DestinationStream {
  private fd: number;
  private size: number;

  constructor(
    private readonly filePath: string,
    private readonly maxBytes = 50 * 1024 * 1024,
    private readonly maxFiles = 10,
  ) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.fd = fs.openSync(filePath, "a");
    this.size = fs.fstatSync(this.fd).size;
  }

  write(chunk: string): void {
    if (this.size + chunk.length > this.maxBytes) this.rotate();
    fs.writeSync(this.fd, chunk);
    this.size += Buffer.byteLength(chunk);
  }

  private rotate(): void {
    fs.closeSync(this.fd);
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = `${this.filePath}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${this.filePath}.${i + 1}`);
    }
    const oldest = `${this.filePath}.${this.maxFiles}`;
    if (fs.existsSync(oldest)) fs.rmSync(oldest);
    fs.renameSync(this.filePath, `${this.filePath}.1`);
    this.fd = fs.openSync(this.filePath, "a");
    this.size = 0;
  }
}

/** Destination that scrubs registered secrets from every serialized line before writing it. */
export class ScrubbingStream implements DestinationStream {
  constructor(
    private readonly targets: DestinationStream[],
    private readonly registry: SecretRegistry,
  ) {}

  write(chunk: string): void {
    const clean = this.registry.scrub(chunk);
    for (const t of this.targets) t.write(clean);
  }
}

export interface LoggerOptions {
  level: string;
  logDir?: string | undefined;
  registry?: SecretRegistry;
  /** Extra destination (tests capture output through this). */
  destination?: DestinationStream;
}

export function createLogger(opts: LoggerOptions): Logger {
  const targets: DestinationStream[] = [opts.destination ?? { write: (s: string) => process.stdout.write(s) }];
  if (opts.logDir) targets.push(new RotatingFileStream(path.join(opts.logDir, "multbot.log")));
  return pino(
    {
      level: opts.level,
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      base: { app: "multbot" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    new ScrubbingStream(targets, opts.registry ?? secrets),
  );
}

/** Minimal logger for unit tests / CLI tools. */
export function silentLogger(): Logger {
  return pino({ level: "silent" });
}
