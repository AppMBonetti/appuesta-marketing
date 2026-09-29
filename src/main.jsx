import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import { AuthProvider } from "./lib/AuthContext";

// A deploy renames every hashed chunk, so a tab left open before it still holds
// an index bundle pointing at files that no longer exist. The failure only
// surfaces when something lazy-loads - the spreadsheet readers, which load on
// first upload - and it reads as "Error al importar", blaming the file rather
// than the stale tab. Reload once to pick up the current bundle and carry on.
//
// Guarded by a session flag: if the chunk is genuinely missing rather than
// merely renamed, reloading forever would replace one broken state with a worse
// one, so the second failure is allowed to surface.
const RELOAD_FLAG = "appuesta.chunkReload";
window.addEventListener("vite:preloadError", event => {
  let alreadyTried = false;
  try { alreadyTried = sessionStorage.getItem(RELOAD_FLAG) === "1"; } catch { /* storage unavailable */ }
  if (alreadyTried) return;
  try { sessionStorage.setItem(RELOAD_FLAG, "1"); } catch { /* storage unavailable */ }
  event.preventDefault();
  window.location.reload();
});
// A load that gets this far is running a consistent bundle, so the guard resets
// and the next deploy can recover the same way.
window.addEventListener("load", () => {
  try { sessionStorage.removeItem(RELOAD_FLAG); } catch { /* storage unavailable */ }
});

// Three pages, one build: /afiliados is the team's affiliate dashboard, /portal
// is where an affiliate sees their own figures, everything else is marketing.
// Netlify's SPA fallback serves index.html for all of them. The two affiliate
// pages are separate chunks fetched only on their own path, so the marketing
// dashboard loads exactly as it did before they existed.
const AffiliatesApp = lazy(() => import("./AffiliatesApp.jsx"));
const PortalApp = lazy(() => import("./PortalApp.jsx"));
const path = window.location.pathname;
const Root = /^\/portal(\/|$)/i.test(path) ? PortalApp
  : /^\/(afiliados|affiliates)(\/|$)/i.test(path) ? AffiliatesApp
  : App;

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <AuthProvider>
      <Suspense fallback={null}>
        <Root />
      </Suspense>
    </AuthProvider>
  </StrictMode>,
);
