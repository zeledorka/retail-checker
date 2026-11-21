import type { Metadata, Viewport } from "next";
import { Nunito } from "next/font/google";
import "./globals.css";
import { Balloons } from "@/components/Balloons";

const nunito = Nunito({ variable: "--font-nunito", subsets: ["latin"], weight: ["600", "700", "800", "900"] });

export const metadata: Metadata = {
  title: "AI Courtroom",
  description: "Bet on the AI lawyer you believe. Whisper them a tip. Hear the verdict.",
};
export const viewport: Viewport = { themeColor: "#1f8fff", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${nunito.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <Balloons />
        {children}
      </body>
    </html>
  );
}
