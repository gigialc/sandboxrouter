import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Footer, Nav } from "@/components/chrome";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "sandboxrouter: one API for every sandbox", template: "%s · sandboxrouter" },
  description:
    "OpenRouter for sandboxes. Route your AI agent's code to Maritime, E2B, Daytona, Modal, Vercel and more, by price, speed or capability, with automatic fallback.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <Nav />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
