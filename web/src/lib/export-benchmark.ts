type ChartOptions = {
  jobLabel: string;
  description: string;
  measuredThrough: string;
  sourceUrl: string;
  note: string;
  summaries: readonly { label: string; name: string; metric: string }[];
};

const SVG_NS = "http://www.w3.org/2000/svg";
const PRESENTATION = [
  "fill", "stroke", "stroke-width", "stroke-linejoin", "paint-order", "opacity",
  "font-family", "font-size", "font-weight", "letter-spacing", "text-anchor",
];

function imageFrom(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Couldn't render the benchmark image."));
    image.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

function asDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function localAsset(url: URL): Promise<Blob> {
  if (url.origin !== location.origin) throw new Error("The chart asset is not on this site.");
  const response = await fetch(url, { mode: "same-origin" });
  if (!response.ok) throw new Error("Couldn't load a chart asset.");
  return response.blob();
}

function inlineLogos(svg: SVGSVGElement): Promise<void[]> {
  const logos = new Map<string, Promise<string>>();
  return Promise.all(Array.from(svg.querySelectorAll("image"), async (node) => {
    const href = node.getAttribute("href");
    if (!href) return;
    try {
      let logo = logos.get(href);
      if (!logo) {
        logo = localAsset(new URL(href, document.baseURI)).then(async (blob) => {
          // PNG data URLs are supported inside the SVG image, including for ICO and SVG source logos.
          const image = await imageFrom(blob);
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 64;
          const context = canvas.getContext("2d");
          if (!context || !image.naturalWidth || !image.naturalHeight) throw new Error("Invalid logo image.");
          const scale = 64 / Math.max(image.naturalWidth, image.naturalHeight);
          const width = image.naturalWidth * scale;
          const height = image.naturalHeight * scale;
          context.drawImage(image, (64 - width) / 2, (64 - height) / 2, width, height);
          return canvas.toDataURL("image/png");
        });
        logos.set(href, logo);
      }
      node.setAttribute("href", await logo);
    } catch {
      const letter = document.createElementNS(SVG_NS, "text");
      letter.textContent = node.parentElement?.getAttribute("aria-label")?.charAt(0) ?? "";
      letter.setAttribute("x", String(node.x.baseVal.value + node.width.baseVal.value / 2));
      letter.setAttribute("y", String(node.y.baseVal.value + node.height.baseVal.value / 2 + 4));
      letter.setAttribute("text-anchor", "middle");
      letter.setAttribute("font-size", "10");
      letter.setAttribute("fill", "#555");
      node.replaceWith(letter);
    }
  }));
}

async function inlineFonts(svg: SVGSVGElement) {
  const bare = (family: string) => family.trim().replace(/^["']|["']$/g, "");
  const families = new Set(Array.from(svg.querySelectorAll("text"), (node) => bare(node.style.fontFamily.split(",")[0])));
  const loaded = Array.from(document.fonts).filter((font) => font.status === "loaded" && families.has(bare(font.family)));
  const styles: Promise<string>[] = [];
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of rules) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const family = bare(rule.style.getPropertyValue("font-family"));
      const range = rule.style.getPropertyValue("unicode-range");
      if (!loaded.some((font) => bare(font.family) === family && (
        !range || font.unicodeRange.toLowerCase().replace(/\s/g, "") === range.toLowerCase().replace(/\s/g, "")
      ))) continue;
      const src = rule.style.getPropertyValue("src").match(/url\(["']?([^"')]+)["']?\)/);
      if (!src) continue;
      const url = new URL(src[1], sheet.href ?? document.baseURI);
      styles.push(localAsset(url).then(asDataUrl).then((data) => rule.cssText.replace(src[1], data)).catch(() => ""));
    }
  }
  const css = (await Promise.all(styles)).join("\n");
  if (css) {
    const style = document.createElementNS(SVG_NS, "style");
    style.textContent = css;
    svg.prepend(style);
  }
}

function wrap(ctx: CanvasRenderingContext2D, text: string, font: string, width: number) {
  const lines: string[] = [];
  let line = "";
  ctx.font = font;
  for (const word of text.trim().split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Copy the rendered plot, then add the workload context a standalone image needs. */
export async function downloadBenchmarkChart(svg: SVGSVGElement, options: ChartOptions): Promise<void> {
  const { width, height } = svg.getBoundingClientRect();
  if (!width || !height) throw new Error("The benchmark chart is not visible.");
  const theme = getComputedStyle(svg);
  const token = (name: string) => theme.getPropertyValue(name).trim();
  const background = token("--bg");
  const ink = token("--ink");
  const muted = token("--muted");
  const line = token("--line");
  const accent = token("--accent");
  const accentInk = token("--accent-ink") || accent;
  const sans = theme.fontFamily;
  const mono = token("--font-geist-mono") || "monospace";

  const clone = svg.cloneNode(true) as SVGSVGElement;
  const originals = [svg, ...svg.querySelectorAll("*")];
  [clone, ...clone.querySelectorAll("*")].forEach((node, index) => {
    const computed = getComputedStyle(originals[index]);
    const style = (node as SVGElement).style;
    for (const property of PRESENTATION) style.setProperty(property, computed.getPropertyValue(property));
  });
  // The source has overflow-visible axis/point labels. Leave room for their overhang.
  const plotWidth = Math.ceil(width) + 16;
  const plotHeight = Math.ceil(height) + 16;
  clone.setAttribute("width", String(plotWidth));
  clone.setAttribute("height", String(plotHeight));
  clone.setAttribute("viewBox", `-8 -8 ${plotWidth} ${plotHeight}`);

  await document.fonts.ready;
  await Promise.all([inlineFonts(clone), inlineLogos(clone)]);
  const chart = await imageFrom(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser couldn't create a PNG.");
  const padding = 32;
  const cardWidth = Math.max(640, Math.min(1240, plotWidth + padding * 2));
  const contentWidth = cardWidth - 2 * padding;
  const chartHeight = plotHeight * contentWidth / plotWidth;
  const titleFont = `400 32px ${sans}`;
  const paragraphFont = `14px ${sans}`;
  const title = wrap(ctx, `${options.jobLabel}: price vs speed`, titleFont, contentWidth);
  const description = wrap(ctx, options.description, paragraphFont, contentWidth);
  const columns = cardWidth >= 800 ? Math.max(1, options.summaries.length) : 1;
  const columnWidth = contentWidth / columns;
  const summaries = options.summaries.map(({ label, name, metric }) => ({
    label: wrap(ctx, label.toUpperCase(), `11px ${sans}`, columnWidth - 24),
    name: wrap(ctx, name, `17px ${sans}`, columnWidth - 24),
    metric: wrap(ctx, metric, `13px ${mono}`, columnWidth - 24),
  }));
  const rowHeight = Math.max(0, ...summaries.map((item) => 29 + item.label.length * 15 + item.name.length * 22 + item.metric.length * 18));
  const summariesHeight = Math.ceil(summaries.length / columns) * rowHeight;
  const topOfSummaries = 100 + title.length * 38 + description.length * 20;
  const chartTop = topOfSummaries + summariesHeight + 14;
  const note = wrap(ctx, options.note, paragraphFont, contentWidth);
  const source = wrap(ctx, options.sourceUrl.replace(/^https?:\/\/(?:www\.)?/, ""), paragraphFont, contentWidth);
  const footerTop = chartTop + chartHeight + 12;
  const cardHeight = Math.ceil(footerTop + note.length * 20 + source.length * 20 + 73);
  const scale = Math.min(2, 3000 / Math.max(cardWidth, cardHeight));
  canvas.width = Math.ceil(cardWidth * scale);
  canvas.height = Math.ceil(cardHeight * scale);
  ctx.scale(scale, scale);
  ctx.textBaseline = "top";

  const write = (lines: string[], x: number, y: number, font: string, color: string, leading: number, maxWidth = contentWidth) => {
    ctx.font = font;
    ctx.fillStyle = color;
    lines.forEach((text, index) => ctx.fillText(text, x, y + index * leading, maxWidth));
  };
  const rule = (y: number) => {
    ctx.fillStyle = line;
    ctx.fillRect(padding, y, contentWidth, 1);
  };

  ctx.fillStyle = background;
  ctx.fillRect(0, 0, cardWidth, cardHeight);
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, cardWidth, 3);
  ctx.save();
  ctx.translate(padding, 24);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.6;
  ctx.stroke(new Path2D("M1.5 11H7c3 0 3.5-7 8-7M7 11h8M7 11c3 0 3.5 7 8 7"));
  ctx.fillRect(15.5, 2, 4, 4);
  ctx.fillRect(15, 8.5, 5, 5);
  ctx.fillRect(15.5, 16, 4, 4);
  ctx.restore();
  write(["sandboxRouter"], padding + 28, 26, `16px ${sans}`, ink, 20);
  write(title, padding, 61, titleFont, ink, 38);
  write(description, padding, 67 + title.length * 38, paragraphFont, muted, 20);

  summaries.forEach((item, index) => {
    const column = index % columns;
    const x = padding + column * columnWidth;
    const y = topOfSummaries + Math.floor(index / columns) * rowHeight;
    if (column === 0) rule(y);
    if (column > 0) {
      ctx.fillStyle = line;
      ctx.fillRect(x, y, 1, rowHeight);
    }
    write(item.label, x + 12, y + 11, `11px ${sans}`, muted, 15, columnWidth - 24);
    const nameTop = y + 15 + item.label.length * 15;
    write(item.name, x + 12, nameTop, `17px ${sans}`, ink, 22, columnWidth - 24);
    write(item.metric, x + 12, nameTop + item.name.length * 22, `13px ${mono}`, ink, 18, columnWidth - 24);
  });
  rule(topOfSummaries + summariesHeight);
  ctx.drawImage(chart, padding, chartTop, contentWidth, chartHeight);
  rule(footerTop);
  write(note, padding, footerTop + 13, paragraphFont, muted, 20);
  const dateTop = footerTop + 22 + note.length * 20;
  write([`Measured through ${options.measuredThrough} (UTC)`], padding, dateTop, paragraphFont, muted, 20);
  write(source, padding, dateTop + 22, paragraphFont, accentInk, 20);

  const png = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Couldn't encode the benchmark PNG.")), "image/png");
  });
  const url = URL.createObjectURL(png);
  const link = document.createElement("a");
  link.href = url;
  link.download = `sandboxrouter-${options.jobLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-chart.png`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
