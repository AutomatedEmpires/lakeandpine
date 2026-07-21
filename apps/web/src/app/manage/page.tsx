import type { Metadata } from "next";

import { GuestBookingCalendar } from "@/components/GuestBookingCalendar";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Private Booking Calendar",
  description: "Review a Lake & Pine service window through a private management link.",
  robots: { index: false, follow: false },
};

export default function ManageBookingPage() {
  return (
    <div className="route-page">
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">Guest scheduling</span>
          <h1>Your private booking calendar.</h1>
          <p className="lead">Review the exact service window, timezone, and current scheduling status without creating an account.</p>
        </div>
      </div>
      <section className="section" style={{ paddingTop: 20 }}>
        <div className="container"><GuestBookingCalendar /></div>
      </section>
    </div>
  );
}
