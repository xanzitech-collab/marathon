import Link from "next/link";
import { Instagram, Facebook } from "lucide-react";

// lucide-react has no TikTok mark (not part of its generic icon set) — this
// is the standard simplified TikTok logomark, drawn inline to match the
// other two icons' sizing/color conventions instead of pulling in a whole
// brand-icon package for one glyph.
function TikTokIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} fill="currentColor" aria-hidden="true">
      <path d="M12.53.02C13.84 0 15.14.01 16.44 0c.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" />
    </svg>
  );
}

const channels = [
  { label: "Instagram", Icon: Instagram },
  { label: "TikTok", Icon: TikTokIcon },
  { label: "Facebook", Icon: Facebook },
];

const points = [
  {
    title: "One control room",
    body: "Connect every artist's Instagram, TikTok, and Facebook once, then post, schedule, and monitor them all from a single dashboard.",
  },
  {
    title: "Know what's live",
    body: "A status light on every channel shows what's posting, what's ready, and what needs a fix - before a fan notices.",
  },
  {
    title: "Built for teams",
    body: "Hand channels to managers and editors without handing over passwords. Access stays yours to grant and revoke.",
  },
];

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col bg-canvas text-ink">
      <header className="shell flex items-center justify-between py-6">
        <p className="font-data text-[11px] uppercase tracking-[0.2em] text-ink-dim">
          Marathon Entertainment / Crew24
        </p>
        <Link href="/signin" className="btn-secondary px-4 py-2 text-sm">
          Sign in
        </Link>
      </header>

      <section className="shell flex flex-1 flex-col items-start justify-center gap-10 py-16 sm:py-24">
        <div className="max-w-2xl">
          <div className="mb-6 flex flex-wrap items-center gap-4 text-ink-dim">
            {channels.map((c) => (
              <span key={c.label} className="flex items-center gap-1.5" title={c.label}>
                <c.Icon size={20} />
                <span className="sr-only">{c.label}</span>
              </span>
            ))}
          </div>
          <h1 className="font-display text-4xl leading-[1.1] text-ink sm:text-5xl md:text-6xl">
            Every channel, one console.
          </h1>
          <p className="mt-5 max-w-xl text-base text-ink-dim sm:text-lg">
            Marathon Entertainment / Crew24 is the control room for artists and creators running social
            channels at scale - connect accounts, schedule posts, and see what&apos;s live without
            switching apps.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href="/signin" className="btn-primary px-6 py-3 text-sm">
              Sign in to your studio
            </Link>
            <a href="mailto:hello@crew24.app" className="btn-secondary px-6 py-3 text-sm">
              Talk to us
            </a>
          </div>
        </div>

        <div className="grid w-full gap-4 sm:grid-cols-3">
          {points.map((p) => (
            <div key={p.title} className="panel p-5">
              <h2 className="text-sm font-medium text-ink">{p.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-dim">{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="shell flex flex-col items-center justify-between gap-2 border-t border-border py-6 text-xs text-ink-faint sm:flex-row">
        <p>© {new Date().getFullYear()} Marathon Entertainment / Crew24</p>
        <p className="font-data">Built for artist teams</p>
      </footer>
    </main>
  );
}
