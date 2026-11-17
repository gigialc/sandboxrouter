import Link from "next/link";
import { site } from "@/lib/site";

/** A provider's icon on a small white square (so dark icons still show in dark mode), or its first letter. */
export function ProviderLogo({ id, name, size = 18 }: { id: string; name: string; size?: number }) {
  const src = site.logos[id];
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center overflow-hidden border border-line bg-white text-[10px] font-medium text-[#555]"
      style={{ width: size, height: size }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" width={size - 4} height={size - 4} loading="lazy" decoding="async" className="object-contain" style={{ width: size - 4, height: size - 4 }} />
      ) : (
        name.charAt(0).toUpperCase()
      )}
    </span>
  );
}

/** Logo and name, linking to the provider's page, for every table on the site. */
export function ProviderName({ id, name, href = `/providers/${id}`, children }: { id: string; name: string; href?: string; children?: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2.5 align-middle">
      <ProviderLogo id={id} name={name} />
      <Link href={href} className="text-ink group-hover:underline underline-offset-4 decoration-line-2">
        {name}
      </Link>
      {children}
    </span>
  );
}
