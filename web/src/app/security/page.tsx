import type { Metadata } from "next";
import { PageHeader } from "@/components/chrome";
import Link from "next/link";
import { HOSTED_FEE_PCT, HOSTED_URL, REPO } from "@/lib/site";

export const metadata: Metadata = {
  title: "Security",
  description: "What runs where with sandboxRouter: the open-source library on your own keys, and the hosted key on ours.",
};

/** What runs where, what's stored, and what isn't promised: plainly, for whoever has to sign off on it. */
export default function SecurityPage() {
  return (
    <div className="px-5 pt-14 sm:px-10">
      <PageHeader kicker="Security" title="What runs where" />
      <p className="mt-5 max-w-2xl text-[15px] leading-7 text-ink-2">
        There are two ways to use sandboxRouter, and they differ in what passes through us.
      </p>

      <article className="prose-sr mt-12 max-w-2xl">
        <h2>The library, on your own keys</h2>
        <p>
          The open-source package runs inside your own code. It calls each provider&apos;s API directly with keys you set; nothing
          passes through sandboxRouter, and we never see your keys, commands, files or output. Sandboxes run on your provider
          accounts, and each provider bills you. It has no runtime dependencies; each provider&apos;s SDK is an optional peer you
          install yourself. The code is <a href={REPO}>on GitHub</a>, MIT licensed.
        </p>
        <p>
          It keeps a local ledger of the sandboxes it started (so <code>sandboxrouter gc</code> can clean up after a crash) and,
          if you run benchmarks, a local file of start times. Both stay on your machine.
        </p>

        <h2>The hosted key</h2>
        <p>
          With one sandboxRouter key, sandboxes run on sandboxRouter&apos;s accounts with each provider, at the provider&apos;s
          price plus {HOSTED_FEE_PCT}%. Every request, including the commands you run and their output, goes through{" "}
          <code>{HOSTED_URL.replace("https://", "")}</code> on its way to the provider.
        </p>
        <ul>
          <li>
            <strong>What we store:</strong> your account (GitHub sign-in, or an agent sign-up), API keys as SHA-256 hashes, the
            sandboxes you started with their provider, times and cost, and your credit ledger. Payments are handled by Stripe;
            we never see card numbers.
          </li>
          <li>
            <strong>What we don&apos;t store:</strong> the commands you run, their output, or your files. They pass through and
            aren&apos;t kept.
          </li>
          <li>
            <strong>Your own provider keys</strong>, if you add them to the dashboard, are encrypted with AES-256-GCM and used only
            to start, use and stop your sandboxes. Sandboxes on them are billed to you by the provider.
          </li>
          <li>
            <strong>Isolation</strong> is the provider&apos;s: containers, gVisor or micro-VMs depending on the provider. See{" "}
            <Link href="/learn#isolation">how isolation differs</Link>.
          </li>
        </ul>

        <h2>What isn&apos;t promised yet</h2>
        <ul>
          <li>No uptime commitment (SLA) and no region pinning: a sandbox runs wherever the chosen provider runs it.</li>
          <li>Provider accounts on the hosted key are shared by sandboxRouter&apos;s customers, each sandbox isolated by its provider.</li>
          <li>No compliance certifications (such as SOC 2).</li>
        </ul>
        <p>
          If you need any of these, use the library on your own provider accounts, which keeps everything inside your own
          contracts with each provider.
        </p>

        <h2>Reporting a problem</h2>
        <p>
          Report a vulnerability privately through <a href={`${REPO}/security`}>GitHub security advisories</a>. The hosted
          key&apos;s <a href={`${HOSTED_URL}/terms`}>terms</a>, <a href={`${HOSTED_URL}/privacy`}>privacy policy</a> and{" "}
          <a href={`${HOSTED_URL}/acceptable-use`}>acceptable use policy</a> have the rest.
        </p>
      </article>
    </div>
  );
}
