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
          From each provider&apos;s public pricing page, re-read every week (oldest check {oldest}). Estimates, not bills.
        </>
      ),
    },
    {
      title: "Bills are measured",
      body: (
        <>
          Real sandboxes, then the provider&apos;s own billing API: {billed} so far, on{" "}
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
          Anyone with an account can send a result, credited by name; speed is a median of medians. {passed} of {cloud.length}{" "}
          providers pass so far.
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
