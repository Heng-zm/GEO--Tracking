import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

// Using next/font is better for offline mode as it bundles the font
const inter = Inter({ 
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'GeoTrack Now',
  description: 'A minimalist, real-time GPS coordinates display app.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'GeoTrack Now',
  },
  icons: {
    apple: [
      { url: 'https://placehold.co/180x180/09090b/ef4444.png?text=GPS' },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: '#09090b', // Matches zinc-950
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false, // Prevents accidental zooming while using the compass
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} font-sans antialiased`}>
        {children}
      </body>
    </html>
  );
}