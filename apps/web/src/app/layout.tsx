import type { Metadata, Viewport } from "next";
import { Inter, Manrope, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ServiceWorkerRegistrar } from "@/features/notifications/push/register-sw";

const manrope = Manrope({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-display",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Relay — A secure way to message.",
  description:
    "Direct messages with view limits, capture forensics, and a 30-second media window. Built for things meant to be temporary.",
  applicationName: "Relay",
  authors: [{ name: "Relay" }],
  robots: { index: true, follow: true },
  // PWA: Next auto-links the manifest from app/manifest.ts. appleWebApp enables
  // the standalone Home Screen app (the prerequisite for Web Push on iOS).
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Relay" },
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon-180.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#0A0A0B",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${inter.variable} ${geistMono.variable}`}>
      <head>
        <script src="/runtime-env.js" />
      </head>
      <body>
        <ServiceWorkerRegistrar />
        {children}
      </body>
    </html>
  );
}
