import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Shell } from "@/components/shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "SOLARBITER",
  description: "Solana Multi-DEX Arbitrage Terminal — paper first, live only after validation and manual unlock.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
