import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Footer, Nav } from "@/components/chrome";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

const DESCRIPTION =
  "A free, open-source router for AI agent sandboxes: one API across 30+ providers, priced side by side, tested on real accounts, with automatic fallback.";

export const metadata: Metadata = {
  metadataBase: new URL("https://www.sandboxrouter.ai"),
  title: { default: "sandboxrouter: one API for every sandbox", template: "%s · sandboxrouter" },
  description: DESCRIPTION,
  openGraph: { title: "sandboxrouter", description: DESCRIPTION, url: "/", siteName: "sandboxrouter", type: "website" },
  twitter: { card: "summary_large_image", title: "sandboxrouter: one API for every sandbox", description: DESCRIPTION },
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
