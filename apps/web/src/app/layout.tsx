import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lake and Pine",
  description: "Premium cleaning for trust-first estimating, booking, and repeat service.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}