import type { Metadata } from "next";
import { Space_Grotesk, Inter, IBM_Plex_Mono } from "next/font/google";
import { startAutomationLoop } from "@/lib/automation-loop";
import "./globals.css";

const display = Space_Grotesk({
  variable: "--font-display",
  weight: ["500", "600"],
  subsets: ["latin"],
});

const body = Inter({
  variable: "--font-body",
  subsets: ["latin"],
});

const data = IBM_Plex_Mono({
  variable: "--font-data",
  weight: ["400", "500"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Marathon Entertainment / Crew24",
  description: "Run every artist channel from one control room - connect, schedule, and monitor social accounts in one place.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  startAutomationLoop();

  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${data.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-canvas">{children}</body>
    </html>
  );
}