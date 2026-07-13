import Link from "next/link";

export function StickyCta({ phoneTel }: { phoneTel?: string }) {
  return (
    <div className="sticky-cta">
      <Link className="btn btn-primary" href="/book">
        Consult
      </Link>
      <Link className="btn btn-soft" href="/pricing">
        Pricing
      </Link>
      {phoneTel ? (
        <a className="btn btn-ghost" href={phoneTel}>
          Call
        </a>
      ) : null}
    </div>
  );
}
