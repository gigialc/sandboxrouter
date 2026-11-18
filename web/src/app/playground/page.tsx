import type { Metadata } from "next";
import { pageAlternates } from "@/lib/public-pages";
import { PageHeader } from "@/components/chrome";
import { Playground } from "@/components/Playground";

export const metadata: Metadata = { alternates: pageAlternates("/playground"), title: "Playground" };

export default function PlaygroundPage() {
  return (
    <>
      <div className="px-5 sm:px-10 pt-14 pb-10">
        <PageHeader kicker="Local playground" title="Try your own SandboxRouter server">
          Connect to a SandboxRouter server you run, start a sandbox with your configured providers, and watch the output stream.
          Your provider keys stay on your server.
        </PageHeader>
      </div>
      <Playground />
    </>
  );
}
