import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Footer, Nav } from "@/components/chrome";
import { site } from "@/lib/site";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

const CLOUD = site.providers.filter((p) => !p.local);
const DESCRIPTION = `A free, open-source router for AI agent sandboxes: one API across ${CLOUD.length} providers, priced side by side, ${
  CLOUD.filter((p) => p.live.status === "passed").length
} of them tested on real accounts; if one can't start a sandbox, the next one does.`;

export const metadata: Metadata = {
  metadataBase: new URL("https://www.sandboxrouter.ai"),
  title: { default: "sandboxRouter: one API for every sandbox", template: "%s · sandboxRouter" },
  description: DESCRIPTION,
  openGraph: { title: "sandboxRouter", description: DESCRIPTION, url: "/", siteName: "sandboxRouter", type: "website" },
  twitter: { card: "summary_large_image", title: "sandboxRouter: one API for every sandbox", description: DESCRIPTION },
};

/**
 * Apply a theme picked with the header toggle before first paint, so a dark choice doesn't flash light.
 * Links to the hosted dashboard (another origin) carry the theme showing here, so it opens in the same one.
 */
const THEME_SCRIPT = `try{var t=localStorage.getItem("theme");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}
document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest('a[href^="https://api.sandboxrouter.ai"]');if(!a)return;var d=document.documentElement.dataset.theme||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");var u=new URL(a.href);u.searchParams.set("theme",d);a.href=u.toString()},true);`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col">
        <Nav />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
