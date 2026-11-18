import published from "@/data/published.json";
import { recommend, type PublishedData, type RecPriority } from "@/lib/recommend";
import { site } from "@/lib/site";
import { HomeContent } from "@/components/HomeContent";
import { Storm, type StormMode, type StormTower } from "@/components/Storm";

const DATA = published as unknown as PublishedData;


/** The front page: a storm over every provider we've timed, where each strike is the router's real pick, then everything else. */
export default function Home() {
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
    <>
      <Storm towers={towers} modes={modes} providerCount={cloud} measuredOn={DATA.dataThrough.slice(0, 10)} />
      <HomeContent />
    </>
  );
}
