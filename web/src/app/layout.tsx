import type { Metadata } from "next";
import { Instrument_Serif, Inter, IBM_Plex_Mono } from "next/font/google";
import { startAutomationLoop } from "@/lib/automation-loop";
import "./globals.css";

const display = Instrument_Serif({
  variable: "--font-display",
  weight: "400",
  style: "italic",
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
  title: "Only1Marathon Studio",
  description: "Run your artist's Instagram channels from one control room.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  startAutomationLoop();

  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${data.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-canvas">{children}</body>
    </html>
  );
}