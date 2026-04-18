import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'OPTIRISK — Counterparty Risk Simulator',
  description: 'High-frequency counterparty contagion simulator',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
