import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";

import { ChatDock } from "@/components/ChatDock";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { StickyCta } from "@/components/StickyCta";
import { Toast } from "@/components/Toast";
import { APP_URL, authEnabled, BUSINESS_EMAIL, BUSINESS_PHONE, BUSINESS_PHONE_TEL } from "@/lib/env";
import { serializeJsonLd } from "@/lib/json-ld";

import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: {
    default: "Lake & Pine Cleaning Co. | Thoughtful Home Service Planning",
    template: "%s | Lake & Pine Cleaning Co.",
  },
  description:
    "Build a thoughtful cleaning request with property details, room notes, preferences, pets, access planning, and human confirmation.",
  keywords: [
    "home cleaning service planning",
    "cleaning request workflow",
    "recurring cleaning preferences",
    "room cleaning checklist",
    "property cleaning profile",
  ],
  openGraph: {
    siteName: "Lake & Pine Cleaning Co.",
    type: "website",
  },
};

export const viewport = {
  themeColor: "#062a25",
};

const localBusinessJsonLd = {
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  name: "Lake & Pine Cleaning Co.",
  description: "Home cleaning request and service-planning experience.",
  email: BUSINESS_EMAIL,
  priceRange: "$$",
  makesOffer: [
    { "@type": "Offer", name: "Essential Home Reset", price: "139", priceCurrency: "USD" },
    { "@type": "Offer", name: "Pine & Polish Deep Clean", price: "299", priceCurrency: "USD" },
    { "@type": "Offer", name: "Move In / Move Out Detail", price: "369", priceCurrency: "USD" },
    { "@type": "Offer", name: "Lakehouse Turnover", price: "125", priceCurrency: "USD" },
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
        <Footer />
        <Toast />
      </body>
    </html>
  );

  return authEnabled ? <ClerkProvider>{shell}</ClerkProvider> : shell;
}
