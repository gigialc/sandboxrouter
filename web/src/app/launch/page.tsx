import type { Metadata } from "next";
import { Instrument_Serif } from "next/font/google";
import published from "@/data/published.json";
import { recommend, type PublishedData, type RecPriority } from "@/lib/recommend";
import { site } from "@/lib/site";
import { HomeContent } from "@/components/HomeContent";
import { Storm, type StormMode, type StormTower } from "@/components/Storm";

const serif = Instrument_Serif({ weight: "400", subsets: ["latin"], variable: "--font-launch-serif" });

export const metadata: Metadata = {
  title: "Launch",
  description: "Lightning takes the fastest path down. sandboxRouter does the same for your code.",
};

const DATA = published as unknown as PublishedData;

/**
 * The site's own colours, at dusk: while this page is open the header, the sections under the storm and the
 * footer all use the storm's palette, whichever theme was picked. Tripled :root outranks the theme rules.
 */
const DUSK = `:root:root:root{color-scheme:dark;--bg:#0c0a09;--panel:#171210;--panel-2:#201814;--ink:#f4e6c8;--ink-2:#d6c6a6;--muted:#9c8c74;--line:#2e231c;--line-2:#43342a;--bad:#f07171;--accent:#ff8a3d;--accent-ink:#ffab6e;--accent-soft:#2c180c;--ok:#ff8a3d;--bar:#ff8a3d;--chart:#ff8a3d}`;

/** The launch page: a storm over every provider we've timed. Each strike is the router's real pick. */
export default function LaunchPage() {
  const towers: StormTower[] = Object.entries(DATA.start)
    .map(([id, s]) => ({ id, name: s.name, ms: Math.round(s.medianCreateMs), usd: s.hourlyUsd }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const order = (priority: RecPriority) => recommend(DATA, { job: "start", priority }).results.map((r) => r.provider);
  const modes: StormMode[] = [
    { key: "speed", label: "Fastest", order: order("speed") },
    { key: "cost", label: "Cheapest", order: order("cost") },
    { key: "value", label: "Best value", order: order("value") },
    { key: "failover", label: "Failover", order: order("speed") },
  ];
  const cloud = site.providers.filter((p) => !p.local).length;
  return (
    <div className={serif.variable}>
      <style>{DUSK}</style>
      <Storm towers={towers} modes={modes} providerCount={cloud} measuredOn={DATA.dataThrough.slice(0, 10)} />
      {/* Everything the homepage says, under the storm. */}
      <div className="bg-bg pt-20 pb-24 text-ink">
        <HomeContent hero={false} />
      </div>
    </div>
  );
}
