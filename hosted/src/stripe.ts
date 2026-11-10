import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The two Stripe calls the service needs, over plain fetch: a Checkout page for a top-up, and the
 * webhook that confirms it was paid. https://docs.stripe.com/api/checkout/sessions/create
 */
export async function createCheckout(opts: {
  secretKey: string;
  userId: string;
  cents: number;
  successUrl: string;
  cancelUrl: string;
  email?: string | null;
  fetch?: typeof fetch;
  apiBase?: string;
}): Promise<{ id: string; url: string }> {
  const form = new URLSearchParams({
    mode: "payment",
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    client_reference_id: opts.userId,
    "metadata[user_id]": opts.userId,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(opts.cents),
    "line_items[0][price_data][product_data][name]": "sandboxrouter credit",
  });
  if (opts.email) form.set("customer_email", opts.email);
  const res = await (opts.fetch ?? fetch)(`${opts.apiBase ?? "https://api.stripe.com"}/v1/checkout/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.secretKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const body = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
  if (!res.ok || !body.url || !body.id) throw new Error(`Stripe: ${body.error?.message ?? res.status}`);
  return { id: body.id, url: body.url };
}

/** Check the `Stripe-Signature` header and parse the event. https://docs.stripe.com/webhooks#verify-manually */
export function verifyWebhook(raw: Buffer, header: string | undefined, secret: string, now = Date.now(), toleranceSeconds = 300): any {
  const parts = Object.fromEntries(
    (header ?? "").split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const signatures = (header ?? "")
    .split(",")
    .filter((kv) => kv.trim().startsWith("v1="))
    .map((kv) => kv.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !signatures.length) throw new Error("missing Stripe signature");
  if (Math.abs(now / 1000 - t) > toleranceSeconds) throw new Error("Stripe signature too old");
  const expected = createHmac("sha256", secret).update(`${t}.`).update(raw).digest();
  const ok = signatures.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!ok) throw new Error("bad Stripe signature");
  return JSON.parse(raw.toString("utf8"));
}

/** For tests: a header Stripe would send for this body. */
export function signWebhook(raw: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
}
