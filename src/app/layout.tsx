import type { Metadata } from 'next';
import { connection } from 'next/server';
import './globals.css';

export const metadata: Metadata = {
  title: 'Script Modernizer — SQL and Shell ==> SQL and Python',
  description: 'Converts Oracle 19c SQL, PL/SQL and Unix shell scripts into SQL that runs on both 19c and 26ai, and Python.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection(); // dynamic rendering: every response carries a fresh CSP nonce
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
