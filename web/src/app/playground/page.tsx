import type { Metadata } from "next";
import { Playground } from "@/components/Playground";

export const metadata: Metadata = { title: "Playground" };

export default function PlaygroundPage() {
  return (
    <>
      <div className="px-5 sm:px-10 pt-16 pb-10">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">Playground</p>
        <h1 className="mt-4 text-4xl font-normal tracking-[-0.035em]">Run code in a real sandbox</h1>
        <p className="mt-4 max-w-xl text-[14px] leading-6 text-ink-2">
          Connect to a sandboxrouter server you run, start a sandbox on any provider you have keys for, and watch the output stream
          in. Your keys never leave your machine.
        </p>
      </div>
      <Playground />
    </>
  );
}
