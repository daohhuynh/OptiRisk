import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OptiRisk — Counterparty Risk Simulator",
  description:
    "Real-time HFT-style counterparty credit risk visualization powered by a zero-allocation C++23 engine and WebGL.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-surface-900 text-slate-200 antialiased">
        {children}
      </body>
    </html>
  );
}
