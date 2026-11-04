import { site, usd } from "@/lib/site";

const OSES = [
  ["linux", "Linux"],
  ["windows", "Windows"],
  ["android", "Android"],
  ["ios", "iOS"],
] as const;

/** Desktops and phones, priced per OS. Alphabetical; the router picks the cheapest for the OS you ask for. */
export function DesktopTable() {
  const rows = [...site.desktops].sort((a, b) => a.name.localeCompare(b.name));
  const cheapest = Object.fromEntries(
    OSES.map(([os]) => [os, Math.min(...rows.map((r) => r.os[os] ?? Infinity))]),
  ) as Record<string, number>;

  return (
    <div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.12em] text-muted">
            <th className="py-3 pr-4 font-normal">Provider</th>
            <th className="hidden py-3 pr-4 font-normal md:table-cell">Default size</th>
            {OSES.map(([, label]) => (
              <th key={label} className="py-3 pr-4 font-normal">
                {label}
              </th>
            ))}
            <th className="hidden py-3 font-normal sm:table-cell">Human takeover</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} className="border-t border-line">
              <td className="py-3 pr-4 text-ink">
                <a href={d.docs} className="hover:underline underline-offset-4 decoration-line-2">
                  {d.name}
                </a>
              </td>
              <td className="hidden py-3 pr-4 text-ink-2 tnum md:table-cell">{d.size}</td>
              {OSES.map(([os]) => {
                const v = d.os[os];
                return (
                  <td key={os} className="py-3 pr-4 font-mono tnum">
                    {v === undefined ? (
                      d.planOnly?.includes(os) ? (
                        <span className="text-ink-2" title={`${d.name} ${os}: monthly plan only, no hourly price`}>
                          plan
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )
                    ) : (
                      <span className={v === cheapest[os] ? "text-ink" : "text-ink-2"} title={`${d.name} ${os}: ${usd(v)} per hour`}>
                        {usd(v)}
                        <span className="text-muted">/hr</span>
                      </span>
                    )}
                  </td>
                );
              })}
              <td className="hidden py-3 text-ink-2 sm:table-cell">{d.takeover ? "Yes" : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-4 text-[12px] leading-5 text-muted">
        Machines with a screen your model drives with clicks and keys. <span className="font-mono">router.computer({`{ os }`})</span>{" "}
        starts one on the cheapest provider for that OS among those you have keys for, ties alphabetical. Human takeover means a
        person can open a link to handle a login or CAPTCHA. Default sizes differ a lot, so compare price and size together.
      </p>
    </div>
  );
}
