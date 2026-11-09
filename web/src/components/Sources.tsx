import Link from "next/link";
import { site } from "@/lib/site";

/** Where every number on the site comes from, and who can change it. Shown under the provider table. */
export function Sources() {
  const cloud = site.providers.filter((p) => !p.local);
  const passed = cloud.filter((p) => p.live.status === "passed").length;
  const billed = new Set(site.costRuns.filter((r) => r.billedUsd !== null).map((r) => r.provider)).size;
  const oldest = cloud.map((p) => p.pricing.checked).sort()[0];
  const items = [
    {
      title: "Prices are list prices",
      body: (
        <>
          Every price is read off the provider&apos;s public pricing page, with a link and the date it was checked (the oldest is{" "}
          {oldest}). A script re-reads every pricing page each week and flags any change for a person to update. They are estimates
          of what you&apos;ll pay, not bills, and contributors can&apos;t set them.
        </>
      ),
    },
    {
      title: "Bills are measured",
      body: (
        <>
          <code className="font-mono text-[12px]">sandboxrouter cost run</code> starts a real sandbox, keeps it busy, then reads what
          the provider actually charged from its billing API. That shows where the list price misleads: billing only while busy,
          creation fees, plan credits. {billed} provider{billed === 1 ? "" : "s"} measured so far, on{" "}
          <Link href="/benchmarks#real-cost" className="underline decoration-line-2 underline-offset-2 hover:text-ink">
            the benchmarks page
          </Link>
          .
        </>
      ),
    },
    {
      title: "Tests and speed are contributed",
      body: (
        <>
          Anyone with a provider account can run the real-account check and the speed benchmark and send in the result. Each result
          says who ran it, when and from where, and speed is the median of each location&apos;s median, so no single run sets the
          number. {passed} of {cloud.length} providers have passed so far; the rest are tested against mocks of their API.
        </>
      ),
    },
  ];
  return (
    <section id="sources" className="scroll-mt-20 grid gap-10 border-t border-line pt-8 sm:grid-cols-3">
      {items.map((it) => (
        <div key={it.title}>
          <h3 className="text-[16px] text-ink">{it.title}</h3>
          <p className="mt-2 text-[14px] leading-6 text-ink-2">{it.body}</p>
        </div>
      ))}
    </section>
  );
}
