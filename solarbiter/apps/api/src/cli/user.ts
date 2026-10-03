/**
 * Create a dashboard user. The password is read from stdin (never from argv / history).
 *   pnpm user:create <username>          (prompts for the password, min. 12 characters)
 *   echo "$PW" | pnpm user:create admin
 */
import { Database, migrate } from "@solarbiter/database";
import { createLogger, loadConfig } from "@solarbiter/shared/node";
import { Auth } from "../auth.js";

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write("Password (min. 12 characters, input hidden is not supported — use a pipe for scripts): ");
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

const username = process.argv[2];
if (!username || !/^[a-zA-Z0-9_.-]{3,50}$/.test(username)) {
  console.error("usage: user:create <username>   (3–50 chars: letters, digits, _ . -)");
  process.exit(2);
}
const config = loadConfig();
const db = new Database(config.database.url, createLogger({ level: "warn" }));
try {
  await migrate(db, createLogger({ level: "warn" }));
  const password = await readPassword();
  await new Auth(db, config.sessionTtlHours).createUser(username, password);
  console.log(`user ${username} created`);
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
