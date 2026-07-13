import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";

import { ChatDock } from "@/components/ChatDock";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { StickyCta } from "@/components/StickyCta";
import { Toast } from "@/components/Toast";
import {
  APP_URL,
  authEnabled,
  BUSINESS_PHONE,
  BUSINESS_PHONE_TEL,
  PUBLIC_BUSINESS_EMAIL,
} from "@/lib/env";
import { serializeJsonLd } from "@/lib/json-ld";

import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: {
    default: "Lake & Pine Cleaning Co. | Premium Property Care",
    template: "%s | Lake & Pine Cleaning Co.",
  },
  description:
    "Premium interior care for private estates, construction handoffs, lake and marine interiors, and select professional spaces.",
  keywords: [
    "premium property cleaning",
    "private estate cleaning",
    "post construction cleaning",
    "marine interior cleaning",
    "commercial cleaning consultation",
  ],
  openGraph: {
    siteName: "Lake & Pine Cleaning Co.",
    type: "website",
    title: "Lake & Pine Cleaning Co. | Premium Property Care",
    description:
      "From final walkthrough to ready-for-arrival: defined interior-care plans for exceptional properties.",
  },
  twitter: { card: "summary", title: "Lake & Pine Cleaning Co. | Premium Property Care" },
};

export const viewport = {
  themeColor: "#062a25",
};

const localBusinessJsonLd = {
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  name: "Lake & Pine Cleaning Co.",
  url: APP_URL,
  description:
    "Premium interior-care planning for private residences, construction handoffs, marine interiors, and select professional spaces.",
  priceRange: "Custom proposal",
  ...(PUBLIC_BUSINESS_EMAIL ? { email: PUBLIC_BUSINESS_EMAIL } : {}),
  makesOffer: [
    { "@type": "Offer", name: "Private Estate Care" },
    { "@type": "Offer", name: "Construction Handoff" },
    { "@type": "Offer", name: "Lake & Marine Interior Care" },
    { "@type": "Offer", name: "Select Commercial Care" },
  ],
  ...(BUSINESS_PHONE ? { telephone: BUSINESS_PHONE } : {}),
};

const themeInit = `try{var t=localStorage.getItem("lp-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const shell = (
    <html lang="en" data-theme="day" suppressHydrationWarning>
      <body className={inter.variable}>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(localBusinessJsonLd) }}
        />
        <div className="grain" />
        <div className="aurora" />
        <div className="aurora b" />
        <a className="skip" href="#main">
          Skip to content
        </a>
        <Nav phone={BUSINESS_PHONE} phoneTel={BUSINESS_PHONE_TEL} />
        <main id="main">{children}</main>
        <StickyCta phoneTel={BUSINESS_PHONE_TEL} />
        <ChatDock />
        <Footer
          email={PUBLIC_BUSINESS_EMAIL}
          phone={BUSINESS_PHONE}
          phoneTel={BUSINESS_PHONE_TEL}
        />
        <Toast />
      </body>
    </html>
  );

  return authEnabled ? <ClerkProvider>{shell}</ClerkProvider> : shell;
}
