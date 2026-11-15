import type { Metadata } from "next";
import Link from "next/link";
import { UseCaseTable } from "@/components/UseCaseTable";
import { HOSTED_FEE_PCT } from "@/lib/site";

export const metadata: Metadata = { title: "Best sandbox for the job" };

export default function RankingsPage() {
  return (
    <div className="px-5 sm:px-10 pt-14">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">Rankings</p>
      <h1 className="mt-5 max-w-2xl text-4xl font-normal leading-[1.08] tracking-[-0.035em] sm:text-[44px]">Best sandbox for the job</h1>
      <p className="mt-5 max-w-2xl text-[15px] leading-7 text-ink-2">
        The cheapest provider depends on how long you use it. A provider that charges a full minute loses on a 10-second job and
        wins on a 30-minute one. Pick a job: providers that passed the{" "}
        <Link href="/providers" className="underline underline-offset-4 decoration-line-2">
          real-account check
        </Link>{" "}
        ranked by what that run would be billed, the way the router ranks them. For start times, see{" "}
        <Link href="/benchmarks" className="underline underline-offset-4 decoration-line-2">
          Benchmarks
        </Link>
        .
      </p>

      <div className="mt-10">
        <UseCaseTable />
      </div>

      <section className="prose-sr mt-16 max-w-2xl border-t border-line pt-10">
        <h2>How these are ranked</h2>
        <p>
          Each provider&apos;s list price for the size, corrected where we measured what it really bills, then its billing rules over
          the run: the minimum it charges, the steps it bills in, and any fixed charge per sandbox. That&apos;s the same number the
          router ranks by, so <code>{`router.create({ expectedSeconds: 10 })`}</code> picks the top of the first list. Fixed-size
          providers (E2B, OpenScale, Daytona) can&apos;t give these sizes and aren&apos;t listed. Disk, network and monthly plans are left
          out. On the hosted key, add {HOSTED_FEE_PCT}% to providers you don&apos;t bring your own key for.
        </p>
      </section>
    </div>
  );
}
