import type { Metadata } from "next";
import { PageHeader } from "@/components/chrome";
import { Playground } from "@/components/Playground";

export const metadata: Metadata = { title: "Playground" };

export default function PlaygroundPage() {
  return (
    <>
      <div className="px-5 sm:px-10 pt-14 pb-10">
        <PageHeader kicker="Playground" title="Run code in a real sandbox">
          Connect to a sandboxRouter server you run, start a sandbox on any provider you have keys for, and watch the output stream
          in. Your keys never leave your machine.
        </PageHeader>
      </div>
      <Playground />
    </>
  );
}
