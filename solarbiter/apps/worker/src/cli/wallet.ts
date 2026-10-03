/**
 * Bot wallet management CLI. The private key never appears on screen, in argv or in logs.
 *
 *   pnpm wallet:create             generate a new wallet and write the encrypted keystore
 *   pnpm wallet:import             import an existing key (read from stdin, base58 or JSON array)
 *   pnpm wallet:address            print the public address
 *
 * The passphrase is read from WALLET_KEYSTORE_PASSPHRASE / WALLET_KEYSTORE_PASSPHRASE_FILE.
 */
import { Keypair } from "@solana/web3.js";
import { loadConfig } from "@solarbiter/shared/node";
import { encryptSecretKey, parseSecretKey, readKeystore, writeKeystore } from "@solarbiter/wallet";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const cmd = process.argv[2];
const config = loadConfig();
const file = config.wallet.keystorePath;

try {
  if (cmd === "address") {
    console.log(readKeystore(file).address);
  } else if (cmd === "create" || cmd === "import") {
    const passphrase = config.wallet.passphrase;
    if (!passphrase) throw new Error("set WALLET_KEYSTORE_PASSPHRASE or WALLET_KEYSTORE_PASSPHRASE_FILE first");
    let secret: Uint8Array;
    if (cmd === "create") {
      secret = Keypair.generate().secretKey;
    } else {
      if (process.stdin.isTTY) console.error("Paste the secret key (base58 or JSON array), then press Ctrl-D:");
      secret = parseSecretKey(await readStdin());
    }
    const ks = encryptSecretKey(secret, passphrase);
    secret.fill(0);
    writeKeystore(file, ks);
    console.log(`Keystore written to ${file}`);
    console.log(`Bot wallet address: ${ks.address}`);
    console.log("Fund this address with SOL for shadow / live mode (live stays disabled until validation + manual unlock). Keep the passphrase safe — without it the key cannot be recovered.");
  } else {
    console.error("usage: wallet.ts create|import|address");
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  process.exitCode = 1;
}
