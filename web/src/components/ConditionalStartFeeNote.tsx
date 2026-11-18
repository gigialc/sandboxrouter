import published from "@/data/published.json";
import { provider } from "@/lib/site";

type Fee = { minUsd: number; maxUsd: number; source: string; when?: string };
const FEES = (published as { conditionalStartFees?: Record<string, Fee> }).conditionalStartFees ?? {};

const amountOf = (fee: Fee) => (fee.minUsd === fee.maxUsd ? `$${fee.minUsd.toFixed(2)}` : `$${fee.minUsd.toFixed(2)}–$${fee.maxUsd.toFixed(2)}`);

/** One provider's plan-dependent start fee as a short row note, or "" when it has none. */
export const startFeeNote = (id: string) => (FEES[id] ? `plus ${amountOf(FEES[id])} per start ${FEES[id].when ?? "above its included allowances"}` : "");

/** Whether any of these providers has such a fee. */
export const hasStartFee = (ids: readonly string[]) => ids.some((x) => FEES[x]);

/** The providers among `ids` (or the one `id`) with a start fee that depends on the customer's account or plan. */
export function ConditionalStartFeeNote({ id, ids, what = "estimates" }: { id?: string; ids?: readonly string[]; what?: string }) {
  const shown = [...new Set(ids ?? (id ? [id] : []))].filter((x) => FEES[x]).sort();
  if (!shown.length) return null;
  return (
    <>
      {shown.map((x) => {
        const fee = FEES[x];
        const amount = amountOf(fee);
        return (
          <span key={x}>
            {provider(x)?.name ?? x} charges <a href={fee.source} className="underline underline-offset-2">{amount} per start</a>{" "}
            {fee.when ?? "above its included allowances"}.{" "}
          </span>
        );
      })}
      The {what} exclude {shown.length > 1 ? "those fees" : "that fee"}.
    </>
  );
}
