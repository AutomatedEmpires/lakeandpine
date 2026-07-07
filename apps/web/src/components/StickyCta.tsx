import Link from "next/link";

export function StickyCta({ phoneTel }: { phoneTel: string }) {
  return (
    <div className="sticky-cta">
      <Link className="btn btn-primary" href="/book">
        Book
      </Link>
      <Link className="btn btn-soft" href="/#quote">
        Estimate
      </Link>
      <a className="btn btn-ghost" href={phoneTel}>
        Call
      </a>
    </div>
  );
}
