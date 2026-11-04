import type { Metadata } from "next";
import { PageHeader } from "@/components/chrome";
import { Playground } from "@/components/Playground";

export const metadata: Metadata = { title: "Playground" };

export default function PlaygroundPage() {
  return (
    <>
      <PageHeader eyebrow="Playground" title="Run code in a real sandbox">
        Connect to your own sandboxrouter server, start a sandbox on any provider, and watch the output stream in.
      </PageHeader>
      <Playground />
    </>
  );
}
