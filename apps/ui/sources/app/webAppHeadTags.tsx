/**
 * PWA / iOS install <head> tags for the web app shell. Rendered inside <head>
 * in +html.tsx. Kept as a standalone unit so the install contract is testable
 * without rendering the whole HTML shell.
 */
export function WebAppHeadTags() {
  return (
    <>
      <link rel="manifest" href="/manifest.webmanifest" />
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      <meta name="apple-mobile-web-app-title" content="Happier" />
      <meta name="theme-color" content="#18171C" />
    </>
  );
}
