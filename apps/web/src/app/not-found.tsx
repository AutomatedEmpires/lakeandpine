import Link from "next/link";

export default function NotFound() {
  return (
    <div className="route-page">
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">404</span>
          <h1>That page got tidied away.</h1>
          <p className="lead">It doesn&rsquo;t exist — but the clean you came for does.</p>
          <div className="hero-actions">
            <Link className="btn btn-primary" href="/">
              Back home
            </Link>
            <Link className="btn btn-soft" href="/book">
              Book a clean
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
