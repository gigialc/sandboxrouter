import { provider } from "@/lib/site";

/** Shows the part of the provider's start price that depends on the customer's account. */
export function ConditionalStartFeeNote({ id }: { id: string }) {
  const p = provider(id);
  const fee = p?.pricing.conditionalStartFee;
  if (!fee) return null;
  return (
    <>
      {p.name} charges <a href={fee.source} className="underline underline-offset-2">${fee.minUsd.toFixed(2)}–${fee.maxUsd.toFixed(2)} per start</a>{" "}
      above its included allowances. The estimates exclude those fees.
    </>
  );
}
