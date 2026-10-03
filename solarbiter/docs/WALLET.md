# Wallet

## Kette

```
Frontend → Backend (API) → Execution Service (Worker) → Secure Signer
```

Das Frontend und die API sehen nur **Adresse und Salden**. Nur der Worker lädt den Schlüssel, und dort
nur die Klasse `Signer`.

## Keystore

- Erzeugen: `pnpm wallet:create` · Import: `pnpm wallet:import` (Schlüssel über stdin, base58 oder
  JSON-Array — nie über argv) · Adresse: `pnpm wallet:address`.
- Verschlüsselung: scrypt (N = 2¹⁷) + AES-256-GCM; Datei mit Modus 0600 in einem 0700-Verzeichnis;
  `secrets/` und `*.keystore.json` sind git-ignoriert.
- Passphrase nur aus `WALLET_KEYSTORE_PASSPHRASE` oder einer Datei (`…_FILE`, chmod 600). Fehlt sie,
  ist das Wallet einfach „nicht konfiguriert“ (Paper funktioniert weiter).

## Signer

- Hält den Schlüssel nur im Prozessspeicher; registriert ihn in allen Kodierungen beim Log-Scrubber.
- Signiert **nur** mit einer `IntegrityApproval` des Transaction-Guards, die an den Hash genau dieser
  Nachricht gebunden und höchstens 60 s alt ist; der Fee-Payer muss das Bot-Wallet sein.

## Transaction-Guard

Statisch (dekodierte Nachricht): einziger Signer = Bot-Wallet · nur erlaubte Programme
(ComputeBudget, System, Token, Token-2022, ATA, Jupiter v6; Programm-IDs aus Lookup-Tables verboten) ·
System-Transfers nur an das eigene wSOL-Konto (≤ Tradegröße) oder an Jito-Tip-Konten (≤ Tip-Limit) ·
Token-Programm auf oberster Ebene nur SyncNative und CloseAccount zurück ans Wallet · ATA-Erstellung nur
für das Wallet · Priority-Fee ≤ Limit. Simulation: kein Fehler, das Wallet verliert höchstens
Gebühren + Tip + Rent neuer Token-Konten.

## Abgleich

Der Worker liest Salden alle 30 s (SOL + Token beider Programme) und vergleicht den On-Chain-Saldo mit
„letzte bestätigte Basis + erfasste Live-Ergebnisse“. Abweichung (z. B. Ein-/Auszahlung) →
`BALANCE_MISMATCH` (blockiert Live). Nach Prüfung im Dashboard zurücksetzen — das setzt eine neue Basis.
Ändert sich die Adresse des geladenen Keystores → `WALLET_MISMATCH`.

Auszahlungen bietet SOLARBITER bewusst nicht an (kleinere Angriffsfläche); Ein- und Auszahlungen
erfolgen mit einer normalen Wallet.
