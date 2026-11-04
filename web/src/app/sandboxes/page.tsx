import type { Metadata } from "next";
import { PageHeader } from "@/components/chrome";
import { ProviderExplorer } from "@/components/ProviderExplorer";
import { site } from "@/lib/site";

export const metadata: Metadata = { title: "Sandboxes" };

export default function SandboxesPage() {
  return (
    <>
      <PageHeader eyebrow="Browse" title="Sandboxes">
        {site.providers.length} providers behind one API. Pick a machine size to see what it costs everywhere.
      </PageHeader>
      <ProviderExplorer />
    </>
  );
}
