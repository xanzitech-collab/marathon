import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <section className="w-full max-w-md text-center">
        <h1 className="font-display mt-3 text-5xl text-ink">Only1Marathon Bots</h1>
        <Link
          href="/signin"
          className="mt-8 inline-block rounded-full bg-signal px-6 py-2.5 text-sm font-medium text-canvas transition hover:brightness-110"
        >
          Sign in
        </Link>
      </section>
    </main>
  );
}