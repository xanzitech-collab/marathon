import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <section className="w-full max-w-md text-center">
        <p className="font-data text-xs uppercase tracking-[0.25em] text-faded">On-Air Since 2026</p>
        <h1 className="font-display mt-3 text-5xl text-ink">Only1Marathon Studio</h1>
        <p className="mt-4 text-sm leading-relaxed text-faded">
          One control room for every channel — set the voice, load the media, and let it run.
        </p>
        <Link
          href="/signin"
          className="mt-8 inline-block rounded-full bg-signal px-6 py-2.5 text-sm font-medium text-canvas transition hover:brightness-110"
        >
          Sign in
        </Link>
        <p className="mt-4 font-data text-xs text-faded/70">Invite-only access</p>
      </section>
    </main>
  );
}