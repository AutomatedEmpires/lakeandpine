import Link from "next/link";

import { BrandMark } from "./BrandMark";

type Props = { email?: string; phone?: string; phoneTel?: string };

export function Footer({ email, phone, phoneTel }: Props) {
  return (
    <footer className="footer">
      <div className="container footer-grid premium-footer-grid">
        <div className="footer-brand">
          <BrandMark />
          <p>Interior care for exceptional properties—from final walkthrough to ready-for-arrival.</p>
          <p className="footer-note">Scope and availability are reviewed before service is confirmed.</p>
        </div>
        <div>
          <h4>Programs</h4>
          <Link href="/who-we-serve#estate">Private estates</Link>
          <Link href="/who-we-serve#construction">Construction handoff</Link>
          <Link href="/who-we-serve#marine">Marine interiors</Link>
          <Link href="/who-we-serve#commercial">Commercial care</Link>
        </div>
        <div>
          <h4>Plan</h4>
          <Link href="/services">Services</Link>
          <Link href="/pricing">Pricing + proposals</Link>
          <Link href="/areas">Planning areas</Link>
          <Link href="/book">Request consultation</Link>
        </div>
        <div>
          <h4>Service</h4>
          <Link href="/reviews">Customer feedback</Link>
          <Link href="/terms">Request terms</Link>
          <Link href="/privacy">Privacy notice</Link>
          <Link href="/service-support">Service support</Link>
          <Link href="/dashboard">Customer dashboard</Link>
        </div>
        <div>
          <h4>Contact</h4>
          {phone && phoneTel ? <a href={phoneTel}>{phone}</a> : null}
          {email ? <a href={`mailto:${email}`}>{email}</a> : null}
          {!phone && !email ? <p>Direct phone and email are being activated.</p> : null}
          <Link href="/book">Start with a property request</Link>
          <Link href="/join">Work with Lake &amp; Pine</Link>
        </div>
      </div>
      <div className="container footer-bottom">
        <span>© {new Date().getFullYear()} Lake &amp; Pine Cleaning Co.</span>
        <span>Request · scope · confirm · close out</span>
      </div>
    </footer>
  );
}
