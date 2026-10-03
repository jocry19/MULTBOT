/**
 * Production: static export (`out/`) served by the SOLARBITER API on the same origin.
 * Development: `next dev` proxies /api to the API (default http://127.0.0.1:8788).
 */
const dev = process.env.NODE_ENV !== "production";
const api = process.env.SOLARBITER_API_URL ?? "http://127.0.0.1:8788";

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  ...(dev ? { rewrites: async () => [{ source: "/api/:path*", destination: `${api}/api/:path*` }] } : { output: "export" }),
};
export default config;
