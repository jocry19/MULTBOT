# Sicherheit

## Private Schlüssel

Niemals im Frontend, im LocalStorage, in Logs, in normalen Datenbankfeldern, im Client-JavaScript,
in Git, im Chat, in API-Antworten, in Analytics oder Fehlerlogs. Umsetzung:

- Verschlüsselter Keystore (scrypt + AES-256-GCM), Datei 0600, git-ignoriert; Passphrase nur per
  Umgebung/Datei.
- Nur der Worker lädt den Schlüssel; nur `Signer` hält ihn; er wird in allen Kodierungen beim
  Log-Scrubber registriert und beim Beenden überschrieben.
- Signieren nur mit hash-gebundener Integrity-Approval nach statischem Guard und Simulation.
- Die API besitzt keinen Schlüssel und kann nicht handeln; `/api/wallet` liefert nur Adresse und Salden.

## Geheimnisse

API-Keys, RPC-URLs mit Keys, Jito-Auth, Webhook-URL, Passphrase und Datenbank-Zugang kommen nur aus der
Umgebung. Jede Logzeile und jede Benachrichtigung läuft durch einen Scrubber, der alle registrierten
Geheimnisse ersetzt; pino-Redaction entfernt zusätzlich bekannte Feldnamen. `.env` ist git-ignoriert.

## Web

- Login mit Benutzer und Passwort (scrypt), Session-Token 32 Byte zufällig, nur sein SHA-256 gespeichert,
  Cookie httpOnly + SameSite=Strict (+ Secure hinter HTTPS), Ablauf konfigurierbar.
- CSRF: jede zustandsändernde Anfrage braucht `X-Requested-With: solarbiter` (Browser senden diesen
  Header nicht cross-site ohne CORS-Freigabe).
- Kritische Aktionen (Live aktivieren, Level erhöhen, Notstopp aufheben, Risikolimits erhöhen)
  verlangen zusätzlich das Passwort.
- Ratenlimits je IP (Login 10 / 5 min). Fehlgeschlagene Logins werden protokolliert.
- Header: strikte CSP (`default-src 'self'`; Skripte nur `'self'` plus die SHA-256-Hashes der
  Inline-Bootstrap-Skripte des Exports — kein `'unsafe-inline'`), `X-Frame-Options: DENY`,
  `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP, HSTS hinter HTTPS,
  `Cache-Control: no-store` für die API.
- CORS nur für explizit konfigurierte Origins. Die API bindet standardmäßig an 127.0.0.1; für Zugriff
  von außen einen TLS-Reverse-Proxy vorschalten.

## Echtgeld-Schutz

Harter Umgebungsschalter `LIVE_MODE` · Validierungs-Gate · manuelle Freigabe mit Phrase + Passwort ·
nicht umgehbare Risk-Freigaben · Profit-Guard on-chain · Transaction-Guard · Breaker · Notstopp ·
Risikolimits werden nie automatisch erhöht.

## Audit

Einstellungen (`settings_audit`), Steuerbefehle (`system_events`), Risiko-Ereignisse, Trades,
Versuche und Steuerzeilen sind append-only bzw. unveränderlich (Datenbank-Trigger).

## Betrieb

Container laufen als Nicht-Root-Benutzer; nur der Worker-Container bindet `secrets/` (read-only) ein;
Datenbank und Redis sind im Compose-Netz nicht nach außen veröffentlicht.
