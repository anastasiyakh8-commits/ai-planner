import type { Metadata, Viewport } from "next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Planner — хаос у голові → план на сьогодні",
  description: "Вивали думки голосом або текстом — AI перетворить їх на структуровані задачі й план на сьогодні.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0B1120",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uk">
      <body>
        {children}
        <SpeedInsights />
      </body>
    </html>
  );
}
