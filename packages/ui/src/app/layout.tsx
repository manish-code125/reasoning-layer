import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Decision Trace Viewer',
  description: 'Claim adjudication decision trace portal',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900 antialiased">{children}</body>
    </html>
  );
}
