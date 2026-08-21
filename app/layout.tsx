import "./globals.css";
import { fontDisplay, fontBody, fontMono } from "@/lib/fonts";
import { WalletProvider } from "@/lib/wallet";
import { XmtpProvider } from "@/lib/xmtp/XmtpProvider";
import { Toaster } from "sonner";
import NextTopLoader from "nextjs-toploader";
import { WagmiProviders } from "@/lib/wagmi-providers";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      className={`${fontDisplay.variable} ${fontBody.variable} ${fontMono.variable}`}
    >
      <head>
        {/*
          Site ownership. A public verification token, not a secret — it has
          to be served in the HTML for the verifier to read it. Kept in the root layout so
          it survives the locale redirect off "/": the verifier lands on /en, and a
          tag scoped to one route would be missing wherever it actually looked.
        */}
        <meta name="base:app_id" content="6a84051e6ea1f57fed3336e4" />
        {/**
         * Applies the theme before first paint. In a <script> rather than React
         * state because any render-time decision happens after the browser has
         * already painted the default palette — which is a full-page flash on
         * every load for anyone who chose light.
         */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('mimir-theme');" +
              "if(!t)t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';" +
              "if(t==='light')document.documentElement.dataset.theme='light';}catch(e){}})();",
          }}
        />
      </head>
      <body className="overflow-x-hidden">
        <NextTopLoader
          color="#22D3EE"
          height={2}
          showSpinner={false}
          shadow={false}
        />
        <WagmiProviders>
          <WalletProvider>
            <XmtpProvider>
              {children}
            </XmtpProvider>
            <Toaster
              position="bottom-center"
              theme="dark"
              toastOptions={{
                // Themed tokens rather than fixed hex: a near-black toast on the
                // light palette read as a rendering bug.
                style: {
                  background: "rgb(var(--pv-surface))",
                  border: "1px solid rgb(var(--pv-ink) / 0.14)",
                  color: "rgb(var(--pv-text))",
                  borderRadius: 16,
                  fontFamily: "var(--font-body)",
                },
              }}
            />
          </WalletProvider>
        </WagmiProviders>
      </body>
    </html>
  );
}
