import type { Metadata } from "next";
import { pageAlternates } from "@/lib/public-pages";
import { PageHeader, SectionTitle } from "@/components/chrome";
import { DesktopTable } from "@/components/DesktopTable";
import { PriceIndex } from "@/components/PriceIndex";
import { ProviderTable } from "@/components/ProviderTable";
import { Sources } from "@/components/Sources";

export const metadata: Metadata = { alternates: pageAlternates("/providers"), title: "Providers" };

export default function ProvidersPage() {
  return (
    <div className="px-5 pt-14 sm:px-10">
      <div id="providers" className="scroll-mt-20">
        <PageHeader kicker="Providers" title="What a sandbox costs, everywhere" />
      </div>
      <div className="mt-8 max-w-3xl">
        <PriceIndex />
      </div>
      <div className="mt-12">
        <ProviderTable />
        <p className="mt-4 text-[13px] text-muted">
          <a href="/providers.json" className="underline underline-offset-4">Provider catalog JSON</a> includes all sandbox sizes, desktop and phone prices, and the price index.
        </p>
      </div>
      <div className="mt-12">
        <Sources />
      </div>

      <section className="mt-24">
        <SectionTitle id="desktops" kicker="Desktops & phones">
          Computers your model can see and click
        </SectionTitle>
        <div className="mt-6">
          <DesktopTable />
        </div>
      </section>
    </div>
  );
}
