/**
 * Creates the ADMIN_PASSWORD_HASH value for the dashboard login.
 *   echo -n 'your long password' | pnpm auth:hash-password
 */
import { hashPassword } from "../api/auth.js";

const chunks: Buffer[] = [];
if (process.stdin.isTTY) console.error("Type the password, then press Ctrl-D:");
for await (const c of process.stdin) chunks.push(c as Buffer);
const pw = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
if (pw.length < 12) {
  console.error("password must be at least 12 characters");
  process.exit(1);
}
console.log(await hashPassword(pw));
