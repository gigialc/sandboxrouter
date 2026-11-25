import type { Metadata } from "next";
import { pageAlternates } from "@/lib/public-pages";
import { PageHeader } from "@/components/chrome";
import Link from "next/link";
import { HOSTED_FEE_PCT, HOSTED_URL, REPO } from "@/lib/site";

export const metadata: Metadata = {
  alternates: pageAlternates("/security"),
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

        <h2>Moving files between sandboxes</h2>
        <p>
          <code>move</code> and <code>copy</code> carry a folder from one sandbox to another, on any two providers. The folder
          is packed in the first sandbox, passes through the program that called <code>move</code>, and is unpacked in the
          second.
        </p>
        <ul>
          <li>
            <strong>On your own keys:</strong> the folder goes from one provider, through your own server, to the other. It never
            reaches sandboxRouter.
          </li>
          <li>
            <strong>On the hosted key:</strong> the folder also passes through <code>{HOSTED_URL.replace("https://", "")}</code>,
            over TLS. It is relayed, not written to disk or to a database. File names are part of each request&apos;s address,
            so they, unlike file contents, can appear in access logs.
          </li>
          <li>
            <strong>With <code>encrypt: true</code>:</strong> the folder is encrypted inside the first sandbox and can only be
            opened inside the second, which makes a key pair and keeps the private key. Your server and ours relay bytes
            neither can read (AES-256, with a one-time key sealed to that public key), and the second sandbox checks the
            archive&apos;s SHA-256 before unpacking.
          </li>
          <li>
            <strong>What encryption doesn&apos;t cover:</strong> the two providers that run the sandboxes can see what is on
            them, as with any cloud machine, and so can whoever is able to run commands in them: you, and on the hosted key,
            sandboxRouter. For credentials such as an agent&apos;s login, keep them in your own secret store, leave them out of
            the move with <code>exclude</code>, and put them into the new sandbox yourself.
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
