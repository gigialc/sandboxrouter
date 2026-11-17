/**
 * The race from the launch: one sandbox asked of every provider at the same moment, in real time.
 * A light and a dark cut, shown by theme (globals.css: .light-only, .dark-only); muted and looping, with
 * the still frame instead for people who prefer less motion.
 */
export function RaceVideo() {
  const cut = (theme: "light" | "dark") => (
    <div className={`${theme}-only`}>
      <video
        className="aspect-square w-full border border-line motion-reduce:hidden"
        src={`/race-${theme}.mp4`}
        poster={`/race-${theme}.jpg`}
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        aria-label="Sixteen sandbox providers started at the same moment: each tile shows how fast it was ready and its price per hour"
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="hidden aspect-square w-full border border-line motion-reduce:block"
        src={`/race-${theme}.jpg`}
        alt="Sixteen sandbox providers with how fast each was ready and its price per hour"
      />
    </div>
  );
  return (
    <div>
      {cut("light")}
      {cut("dark")}
      <p className="mt-3 text-[12px] leading-5 text-muted">
        A real run on 16 Nov 2026: one sandbox asked of every provider at once, shown in real time.
      </p>
    </div>
  );
}
