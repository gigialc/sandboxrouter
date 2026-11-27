import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { site } from "@/lib/site";

export const alt = "sandboxRouter: one API for every sandbox";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const ACCENT = "#ff8a3d";
const CREAM = "#f6ead7";

/** The link preview: a still of the storm from the home page, with the pitch and the provider counts from the same data as the site. */
export default async function OpengraphImage() {
  const cloud = site.providers.filter((p) => !p.local);
  const passing = cloud.filter((p) => p.live.status === "passed").length;
  const storm = await readFile(join(process.cwd(), "src/app/og-storm.jpg"), "base64");
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: "#0b0606", fontFamily: "sans-serif" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`data:image/jpeg;base64,${storm}`} width={1200} height={630} alt="" style={{ position: "absolute", top: 0, left: 0 }} />
        {/* Darkens the left and the bottom, where the words sit. */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            display: "flex",
            backgroundImage: "linear-gradient(90deg, rgba(8,4,4,0.88) 0%, rgba(8,4,4,0.55) 42%, rgba(8,4,4,0) 68%), linear-gradient(0deg, rgba(8,4,4,0.7) 0%, rgba(8,4,4,0) 45%)",
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", padding: "56px 68px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 32, color: CREAM }}>
            <svg width="44" height="44" viewBox="0 0 22 22">
              <path d="M1.5 11H7c3 0 3.5-7 8-7M7 11h8M7 11c3 0 3.5 7 8 7" stroke={CREAM} strokeWidth="1.6" fill="none" strokeLinecap="square" />
              <rect x="15.5" y="2" width="4" height="4" fill={ACCENT} />
              <rect x="15" y="8.5" width="5" height="5" fill={ACCENT} />
              <rect x="15.5" y="16" width="4" height="4" fill={ACCENT} />
            </svg>
            sandboxRouter
          </div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: "auto", fontSize: 86, lineHeight: 1.04, letterSpacing: -3.2, color: CREAM }}>
            <span>One API for</span>
            <span style={{ color: ACCENT }}>every sandbox.</span>
          </div>
          <div style={{ display: "flex", marginTop: 26, fontSize: 28, color: "rgba(246,234,215,0.78)" }}>
            {`${cloud.length} providers, priced side by side · ${passing} tested on real accounts`}
          </div>
        </div>
      </div>
    ),
    size,
  );
}
