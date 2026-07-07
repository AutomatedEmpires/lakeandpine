import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";

import { ChatDock } from "@/components/ChatDock";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { StickyCta } from "@/components/StickyCta";
import { Toast } from "@/components/Toast";
import { APP_URL, authEnabled, BUSINESS_EMAIL, BUSINESS_PHONE, BUSINESS_PHONE_TEL } from "@/lib/env";

import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: {
    default: "Lake & Pine Cleaning Co. | Premium Home Cleaning in Coeur d'Alene + Spokane",
    template: "%s | Lake & Pine Cleaning Co.",
  },
  description:
    "Premium home cleaning for Coeur d'Alene and Spokane: instant estimates, calendar scheduling, vetted cleaners, eco-conscious products, and a customer dashboard that remembers your home.",
  keywords: [
    "premium house cleaning Coeur d'Alene",
    "maid service Spokane",
    "deep cleaning CDA",
    "move out cleaning Spokane",
    "Airbnb turnover Post Falls",
    "eco cleaning Hayden",
    "Liberty Lake home cleaners",
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
  description:
    "Premium home cleaning, recurring maid service, deep cleaning, move-in and move-out cleaning, vacation rental turnover, and small office cleaning across Coeur d'Alene and Spokane.",
  telephone: BUSINESS_PHONE,
  email: BUSINESS_EMAIL,
  priceRange: "$$",
  areaServed: [
    "Coeur d'Alene ID",
    "Spokane WA",
    "Post Falls ID",
    "Hayden ID",
    "Liberty Lake WA",
    "Spokane Valley WA",
    "Rathdrum ID",
  ],
  makesOffer: [
    { "@type": "Offer", name: "Essential Home Reset", price: "139", priceCurrency: "USD" },
    { "@type": "Offer", name: "Pine & Polish Deep Clean", price: "299", priceCurrency: "USD" },
    { "@type": "Offer", name: "Move In / Move Out Detail", price: "369", priceCurrency: "USD" },
    { "@type": "Offer", name: "Lakehouse Turnover", price: "125", priceCurrency: "USD" },
  ],
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
          dangerouslySetInnerHTML={{ __html: JSON.stringify(localBusinessJsonLd) }}
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
