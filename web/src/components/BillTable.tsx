import { Num, ResultRow, ResultTable, Txt } from "@/components/results";
import { REPO, RESULTS_REF, site, type CostRow } from "@/lib/site";

const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const usd = (n: number | null, resolution?: number | null) => n === null ? "—" : `$${n.toFixed(resolution === 0.01 ? 2 : 6)}`;
const seconds = (n: number | null) => n === null ? "—" : `${n.toLocaleString("en-US", { maximumFractionDigits: 3 })} s`;
const micros = (n: number) => Math.round(n * 1_000_000);

function EvidenceLink({ file, label, context }: { file: string; label: string; context?: string }) {
  return (
    <a className="underline decoration-line-2 underline-offset-4 hover:text-ink"
      aria-label={context ? `${label} for ${context}` : undefined}
      href={`${REPO}/blob/${RESULTS_REF}/results/cost/${encodeURIComponent(file)}`}>
      {label}
    </a>
  );
}

function reportedNotes(r: CostRow) {
  const shape = `${r.requested.vcpu} vCPU / ${r.requested.memoryGb} GB`;
  const probed = r.delivered && (
    r.delivered.vcpu !== r.requested.vcpu || Math.abs(r.delivered.memoryGb - r.requested.memoryGb) > 0.1 * r.requested.memoryGb
  ) ? `probe saw ${r.delivered.vcpu} vCPU / ${r.delivered.memoryGb} GB` : "";
  return [
    date.format(new Date(r.date)),
    probed ? `${shape} requested` : shape,
    probed,
    r.load ? "CPU load" : "idle",
    r.billResolutionUsd === 0.01 ? "whole cents" : "",
    r.billSource?.includes("before credits") ? "before credits or reservations" : "",
  ].filter(Boolean);
}

function pendingStatus(r: CostRow) {
  if (r.error) return "Run failed";
  if (/no billing (HTTP )?API/i.test(r.billSource ?? "")) return "Provider console required";
  if (/no reader/i.test(r.billSource ?? "")) return "No sandbox-level billing reader";
  if (/could not read/i.test(r.billSource ?? "")) return "Billing API could not be read";
  return "Usage record pending";
}

export function BillTable() {
  const usage = site.costRuns.filter((r) => !r.error && r.billKind === "provider-usage");
  const estimates = site.costRuns.filter((r) => !r.error && r.billKind === "provider-estimate");
  const reported = new Set([...usage, ...estimates].map((r) => r.provider));
  const gaps = [...new Map(site.costRuns.filter((r) => !reported.has(r.provider))
    .reverse().map((r) => [r.provider, r])).values()].reverse();

  return (
    <div className="mt-6 max-w-5xl">
      <h2 id="provider-usage-heading" className="text-[16px] text-ink">Provider-reported usage</h2>
      <p className="mt-2 text-[13px] text-muted">
        One sandbox per row. The list estimate uses end-to-end wall time at the requested size. The provider can
        measure a different runtime or apply credits. A whole-cent zero is below the precision needed to test a sub-cent estimate.
      </p>
      {usage.length > 0 && (
        <>
          <p className="mt-2 text-[12px] text-muted md:hidden">Scroll across the table to see every amount and its source.</p>
          <div role="region" aria-labelledby="provider-usage-heading" tabIndex={0}
            className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            <ResultTable ranked={false} cols={[
              { label: "Wall time" },
              { label: "List estimate" },
              { label: "Reported" },
              { label: "Evidence", left: true },
            ]}>
              {usage.map((r, index) => (
                <ResultRow key={`${r.file}-${r.provider}-${index}`} id={r.provider} name={r.name} notes={reportedNotes(r)}>
                  <Num title={r.billedSeconds === null ? undefined : `Provider recorded ${seconds(r.billedSeconds)}`}>
                    {seconds(r.seconds)}
                  </Num>
                  <Num>{usd(r.predictedUsd)}</Num>
                  <Num strong title={r.billSource ?? undefined}>{usd(r.billedUsd, r.billResolutionUsd)}</Num>
                  <Txt title={r.billSource ?? undefined}>
                    <EvidenceLink file={r.file} label="Usage record" context={`${r.name}, ${date.format(new Date(r.date))}, ${seconds(r.seconds)}`} />
                  </Txt>
                </ResultRow>
              ))}
            </ResultTable>
          </div>
        </>
      )}
      {site.hostedCosts.length > 0 && (
        <div className="mt-9">
          <h2 id="hosted-charges-heading" className="text-[16px] text-ink">SandboxRouter hosted charges</h2>
          <p className="mt-2 text-[13px] text-muted">
            Verified command and deletion on a funded key. The cost includes the hosted fee. Compare the original quote
            at the requested duration with the debit at the recorded runtime. Where available, a second quote uses that runtime.
          </p>
          <p className="mt-2 text-[12px] text-muted md:hidden">Scroll across the table to see every amount and its source.</p>
          <div role="region" aria-labelledby="hosted-charges-heading" tabIndex={0}
            className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            <ResultTable ranked={false} cols={[
              { label: "Original quote" },
              { label: "Runtime quote" },
              { label: "Ledger debit" },
              { label: "Evidence", left: true },
            ]}>
              {site.hostedCosts.map((r, index) => {
                const sameQuote = r.quoteAtRecordedRuntimeUsd === undefined
                  ? r.expectedSeconds === r.runtimeSeconds && micros(r.quoteUsd) === micros(r.chargeUsd)
                  : micros(r.quoteAtRecordedRuntimeUsd) === micros(r.chargeUsd);
                const sameDebit = micros(r.chargeUsd) === micros(r.balanceDeltaUsd)
                  && (r.keySpendDeltaUsd === undefined || micros(r.chargeUsd) === micros(r.keySpendDeltaUsd));
                const canCompare = r.quoteAtRecordedRuntimeUsd !== undefined || r.expectedSeconds === r.runtimeSeconds;
                const quoteBasis = r.quoteAtRecordedRuntimeUsd === undefined ? "Original quote" : "Runtime quote";
                const outcome = !sameDebit ? "Credit debit differs" : !canCompare ? "Different runtimes" : sameQuote ? `${quoteBasis} matched the debit` : `${quoteBasis} differs from the debit`;
                const notes = [
                  outcome,
                  date.format(new Date(r.checkedAt ?? r.date)),
                  `${r.size.vcpu} vCPU / ${r.size.memoryGb} GB`,
                  `${seconds(r.expectedSeconds)} quoted / ${seconds(r.runtimeSeconds)} recorded`,
                  r.minimumSeconds ? `${r.minimumSeconds} s ${r.minimumCovers === "memory" ? "memory " : ""}minimum` : "",
                ].filter(Boolean);
                return (
                  <ResultRow key={`${r.file}-${r.provider}-${index}`} id={r.provider} name={r.name} notes={notes}>
                    <Num>{usd(r.quoteUsd)}</Num>
                    <Num>{usd(r.quoteAtRecordedRuntimeUsd ?? null)}</Num>
                    <Num strong>{usd(r.chargeUsd)}</Num>
                    <Txt>
                      <EvidenceLink file={r.file} label="Ledger record" context={`${r.name}, ${seconds(r.expectedSeconds)} quote`} />
                    </Txt>
                  </ResultRow>
                );
              })}
            </ResultTable>
          </div>
        </div>
      )}
      {(estimates.length > 0 || gaps.length > 0) && (
        <details className="mt-7 border-t border-line pt-4 text-[13px] text-ink-2">
          <summary className="cursor-pointer">Other billing evidence and gaps</summary>
          <ul className="mt-3 space-y-2 pl-5">
            {estimates.map((r, index) => (
              <li key={`${r.file}-${r.provider}-${index}`}>
                <EvidenceLink file={r.file} label={r.name} /> · provider estimate {usd(r.billedUsd)} · {seconds(r.seconds)} run
              </li>
            ))}
            {gaps.map((r) => (
              <li key={r.provider}><EvidenceLink file={r.file} label={r.name} /> · {pendingStatus(r)}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
