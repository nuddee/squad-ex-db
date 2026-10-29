import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "AgriVision QC — SQUAD Result Dashboard",
  description: "Production Quality Control · HMI — Grain Analysis",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
