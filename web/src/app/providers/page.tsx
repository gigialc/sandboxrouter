import type { Metadata } from "next";
import { SectionTitle } from "@/components/chrome";
import { DesktopTable } from "@/components/DesktopTable";
import { ProviderTable } from "@/components/ProviderTable";
import { Sources } from "@/components/Sources";

export const metadata: Metadata = { title: "Providers" };

export default function ProvidersPage() {
  return (
    <div className="px-5 pt-14 sm:px-10">
      <SectionTitle id="providers" kicker="Providers">
        What a sandbox costs, everywhere
      </SectionTitle>
      <div className="mt-6">
        <ProviderTable />
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
