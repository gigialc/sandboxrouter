import { ImageResponse } from "next/og";
import { ranked, site, usd } from "@/lib/site";

export const alt = "sandboxrouter: one API for every sandbox";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const ACCENT = "#007f4f";

/** The link preview: the pitch plus the three cheapest open-sign-up providers at 2 vCPU / 4 GB, from the same data as the site. */
export default function OpengraphImage() {
  const cloud = site.providers.filter((p) => !p.local);
  const passing = cloud.filter((p) => p.live.status === "passed").length;
  const top = ranked("2x4")
    .filter((p) => !p.local && !p.access && !p.prices["2x4"].unfit)
    .slice(0, 3);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#ffffff", padding: "64px 72px", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 30, color: "#000" }}>
          <svg width="40" height="40" viewBox="0 0 22 22">
            <path d="M1.5 11H7c3 0 3.5-7 8-7M7 11h8M7 11c3 0 3.5 7 8 7" stroke="#000" strokeWidth="1.6" fill="none" strokeLinecap="square" />
            <rect x="15.5" y="2" width="4" height="4" fill={ACCENT} />
            <rect x="15" y="8.5" width="5" height="5" fill={ACCENT} />
            <rect x="15.5" y="16" width="4" height="4" fill={ACCENT} />
          </svg>
          sandboxrouter
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 56, fontSize: 76, lineHeight: 1.05, letterSpacing: -3, color: "#000" }}>
          <span>One API for</span>
          <span style={{ color: ACCENT }}>every sandbox.</span>
        </div>
        <div style={{ display: "flex", marginTop: 28, fontSize: 28, color: "#5f5f5f" }}>
          {`${cloud.length} providers, priced side by side · ${passing} tested on real accounts`}
        </div>
        <div style={{ display: "flex", marginTop: "auto", gap: 18 }}>
          {top.map((p, i) => (
            <div
              key={p.id}
              style={{ display: "flex", flexDirection: "column", flex: 1, padding: "18px 22px", border: "2px solid #e3e3e3", borderTop: `6px solid ${i === 0 ? ACCENT : "#e3e3e3"}` }}
            >
              <span style={{ fontSize: 22, color: "#5f5f5f" }}>{p.name}</span>
              <span style={{ fontSize: 36, marginTop: 6, color: "#000" }}>
                {`${p.billing === "active-cpu" ? "≤ " : ""}${usd(p.prices["2x4"].usd)}/hr`}
              </span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", marginTop: 14, fontSize: 18, color: "#5f5f5f" }}>List price at 2 vCPU / 4 GB, cheapest first</div>
      </div>
    ),
    size,
  );
}
