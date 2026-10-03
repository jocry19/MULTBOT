import { Compass } from "lucide-react";
import { useState } from "react";
import { api } from "../api/client";
import { Button, ErrorBox } from "../components/ui";

export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid min-h-full place-items-center p-6">
      <form
        className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-surface p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await api.post("/api/auth/login", { password });
            onSuccess();
          } catch (ex) {
            setErr((ex as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-accent/15 text-accent">
            <Compass size={18} />
          </div>
          <div>
            <div className="font-semibold">MULTBOT Terminal</div>
            <div className="text-[11px] text-muted">Anmeldung erforderlich</div>
          </div>
        </div>
        <input
          type="password"
          autoFocus
          placeholder="Admin-Passwort"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-line-strong bg-surface-2 px-3 py-2 outline-none focus:border-accent"
        />
        {err && <ErrorBox error={err} />}
        <Button type="submit" variant="primary" size="md" loading={busy}>
          Anmelden
        </Button>
      </form>
    </div>
  );
}
