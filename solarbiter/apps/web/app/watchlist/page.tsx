"use client";
import { useState, type FormEvent } from "react";
import { Button, Card, ErrorBox, PageTitle, Table, inputNarrow } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { short, time } from "@/lib/format";

interface W { mint: string; note: string; created_at: string; symbol: string | null; safe: boolean | null; safety_reasons: string[] | null }

export default function Watchlist() {
  const { data, reload } = useApi<W[]>("/api/watchlist", 15_000);
  const [mint, setMint] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("/api/watchlist", { method: "POST", body: { mint: mint.trim(), note } });
      setMint("");
      setNote("");
      reload();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  return (
    <div className="space-y-4">
      <PageTitle title="Watchlist" sub="Beobachtete Token. Gehandelt werden nur Token, die die On-Chain-Sicherheitsprüfung bestehen (Mint, Programm, Freeze-Authority, Allow-/Denylist)." />
      <ErrorBox error={err} />
      <Card title="Token hinzufügen">
        <form onSubmit={add} className="flex flex-wrap gap-2">
          <input className={`${inputNarrow} w-[420px]`} placeholder="Mint-Adresse" value={mint} onChange={(e) => setMint(e.target.value)} />
          <input className={`${inputNarrow} w-48`} placeholder="Notiz" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button type="submit" tone="primary">Hinzufügen</Button>
        </form>
      </Card>
      <Card title="Watchlist">
        <Table head={["Symbol", "Mint", "Notiz", "Sicherheit", "Seit", ""]} empty={!data?.length}>
          {(data ?? []).map((w) => (
            <tr key={w.mint}>
              <td className="font-medium">{w.symbol ?? "?"}</td>
              <td className="num text-mute" title={w.mint}>{short(w.mint, 6)}</td>
              <td className="text-ink2">{w.note}</td>
              <td className={w.safe ? "text-good" : "text-serious"} title={(w.safety_reasons ?? []).join("; ")}>{w.safe === null ? "nicht geprüft" : w.safe ? "✓ sicher" : `! ${(w.safety_reasons ?? [])[0] ?? "abgelehnt"}`}</td>
              <td className="num text-mute">{time(w.created_at)}</td>
              <td><Button onClick={() => void api(`/api/watchlist/${w.mint}`, { method: "DELETE" }).then(reload)}>Entfernen</Button></td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
