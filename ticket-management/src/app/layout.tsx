import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
export const metadata: Metadata = {
  title: "Parallel · Tickets",
  description: "A shared workspace for the Parallel Research ticket experiment.",
  icons: { icon: "/favicon.svg" },
  other: { "agent-policy": "/.well-known/agent-policy" },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="agent-policy" type="application/json" href="/.well-known/agent-policy" />
      </head>
      <body>
        {children}
        <Script src="/agent-gate.js" strategy="beforeInteractive" />
      </body>
    </html>
  );
}
