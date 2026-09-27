import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import "./index.css";
import { api, setUnauthorizedHandler } from "./api/client";
import { Layout } from "./components/Layout";
import { Loading } from "./components/ui";
import { LoginPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";
import { MarketsPage } from "./pages/Markets";
import { DiscoveriesPage } from "./pages/Discoveries";
import { StrategyLabPage } from "./pages/StrategyLab";
import { StrategyDetailPage } from "./pages/StrategyDetail";
import { PaperTradingPage } from "./pages/PaperTrading";
import { LiveTradingPage } from "./pages/LiveTrading";
import { PositionsPage } from "./pages/Positions";
import { OrdersPage } from "./pages/Orders";
import { PortfolioPage } from "./pages/Portfolio";
import { WalletPage } from "./pages/Wallet";
import { TransactionsPage } from "./pages/Transactions";
import { AnalyticsPage } from "./pages/Analytics";
import { BacktestsPage, BacktestDetailPage } from "./pages/Backtests";
import { ResearchPage, DiscoveryRunPage } from "./pages/Research";
import { EventsPage } from "./pages/Events";
import { WalletIntelPage, WalletDetailPage } from "./pages/WalletIntel";
import { SettingsPage } from "./pages/Settings";
import { TokenPage } from "./pages/Token";
import { TradeDetailPage } from "./pages/TradeDetail";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false, placeholderData: (prev: unknown) => prev } },
});

function Root() {
  const [needLogin, setNeedLogin] = useState(false);
  const status = useQuery({ queryKey: ["auth-status"], queryFn: () => api.get<{ authRequired: boolean; authenticated: boolean }>("/api/auth/status") });
  useEffect(() => setUnauthorizedHandler(() => setNeedLogin(true)), []);
  if (status.isLoading) return <Loading label="Verbinde…" />;
  if (needLogin || (status.data?.authRequired && !status.data.authenticated)) {
    return (
      <LoginPage
        onSuccess={() => {
          setNeedLogin(false);
          void queryClient.invalidateQueries();
        }}
      />
    );
  }
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="markets" element={<MarketsPage />} />
        <Route path="discoveries" element={<DiscoveriesPage />} />
        <Route path="strategy-lab" element={<StrategyLabPage />} />
        <Route path="strategy-lab/:id" element={<StrategyDetailPage />} />
        <Route path="paper" element={<PaperTradingPage />} />
        <Route path="live" element={<LiveTradingPage />} />
        <Route path="positions" element={<PositionsPage />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="portfolio" element={<PortfolioPage />} />
        <Route path="wallet" element={<WalletPage />} />
        <Route path="transactions" element={<TransactionsPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="backtests" element={<BacktestsPage />} />
        <Route path="backtests/:id" element={<BacktestDetailPage />} />
        <Route path="research" element={<ResearchPage />} />
        <Route path="research/runs/:id" element={<DiscoveryRunPage />} />
        <Route path="events" element={<EventsPage />} />
        <Route path="wallet-intel" element={<WalletIntelPage />} />
        <Route path="wallet-intel/:address" element={<WalletDetailPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="token/:mint" element={<TokenPage />} />
        <Route path="trades/:mode/:id" element={<TradeDetailPage />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Root />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
