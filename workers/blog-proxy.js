/**
 * Cloudflare Worker: blog-proxy
 *
 * Handles two things in one Worker:
 *   1. Routes www.nidero.se/blog* → app.nidero.se/blog*
 *   2. Replaces the blog's <header> and <footer> with the landing page's
 *      own compiled HTML — so there is ONE source of truth for the nav/footer.
 *
 * Deploy this Worker and add a route:
 *   www.nidero.se/blog*  →  blog-proxy (this Worker)
 *
 * No wrangler.toml needed for a simple route — just paste and deploy via
 * the Cloudflare dashboard (Workers → Create Worker → paste → Save & Deploy).
 */

const BLOG_ORIGIN = "https://app.nidero.se";
const LANDING_ORIGIN = "https://www.nidero.se";

// Cache the landing page nav/footer for 5 minutes so we don't fetch it on
// every request.  The Worker's Cache API persists across requests in the same
// datacenter.
const SHELL_CACHE_TTL = 300; // seconds

async function fetchLandingShell(cache, cacheKey) {
  const cached = await cache.match(cacheKey);
  if (cached) return cached.text();

  const res = await fetch(LANDING_ORIGIN + "/", {
    headers: { "User-Agent": "NideroWorker/1.0" },
  });
  if (!res.ok) return null;

  const html = await res.text();
  const response = new Response(html, {
    headers: { "Cache-Control": `public, max-age=${SHELL_CACHE_TTL}` },
  });
  await cache.put(cacheKey, response.clone());
  return html;
}

function extractTag(html, selector) {
  // Minimal extraction: grabs the first occurrence of an opening tag through
  // its matching closing tag.  Works for <header> and <footer>.
  const tag = selector.replace(/[^a-z]/g, "");
  const open = new RegExp(`<${tag}[^>]*>`, "i");
  const close = new RegExp(`<\\/${tag}>`, "i");
  const startMatch = open.exec(html);
  if (!startMatch) return null;
  const start = startMatch.index;
  const endMatch = close.exec(html.slice(start));
  if (!endMatch) return null;
  const end = start + endMatch.index + endMatch[0].length;
  return html.slice(start, end);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Only handle /blog paths
    if (!url.pathname.startsWith("/blog")) {
      return fetch(request);
    }

    // 1. Fetch blog page from Railway
    const blogUrl = BLOG_ORIGIN + url.pathname + url.search;
    const blogRes = await fetch(blogUrl, {
      headers: {
        ...Object.fromEntries(request.headers),
        Host: new URL(BLOG_ORIGIN).host,
        "X-Forwarded-Host": url.host,
      },
      redirect: "follow",
    });

    // Pass through non-HTML responses (images, fonts, etc.) unchanged
    const ct = blogRes.headers.get("Content-Type") || "";
    if (!ct.includes("text/html")) {
      return new Response(blogRes.body, {
        status: blogRes.status,
        headers: blogRes.headers,
      });
    }

    // 2. Fetch landing page shell (cached)
    const cache = caches.default;
    const cacheKey = new Request(LANDING_ORIGIN + "/__shell__");
    const landingHtml = await fetchLandingShell(cache, cacheKey);

    if (!landingHtml) {
      // Can't fetch landing page — serve blog as-is
      return blogRes;
    }

    const landingHeader = extractTag(landingHtml, "header");
    const landingFooter = extractTag(landingHtml, "footer");

    // Fix anchor hrefs + strip theme toggle (removed from design, belt-and-suspenders)
    const fixedHeader = landingHeader
      ? landingHeader
          .replace(/href="#/g, 'href="/#')
          .replace(/<button[^>]*theme-toggle[^>]*>[\s\S]*?<\/button>/g, '')
      : null;

    // 3. Use HTMLRewriter to swap header + footer and inject shared assets
    const HEAD_INJECT = [
      '<link rel="stylesheet" href="https://www.nidero.se/nav.css"/>',
      '<link rel="icon" type="image/svg+xml" href="https://www.nidero.se/favicon.svg"/>',
      '<link rel="shortcut icon" href="https://www.nidero.se/favicon.ico"/>',
    ].join("");
    let rewriter = new HTMLRewriter()
      .on("head", {
        element(el) {
          // Remove any existing favicon links first, then inject ours
          el.append(HEAD_INJECT, { html: true });
        },
      })
      .on('link[rel="icon"], link[rel="shortcut icon"]', {
        element(el) { el.remove(); },
      });

    if (fixedHeader) {
      rewriter = rewriter.on("header.topbar", {
        element(el) {
          el.replace(fixedHeader, { html: true });
        },
      });
    }

    if (landingFooter) {
      rewriter = rewriter.on("footer.footer", {
        element(el) {
          el.replace(landingFooter, { html: true });
        },
      });
    }

    const newHeaders = new Headers(blogRes.headers);
    newHeaders.set("X-Proxied-By", "NideroWorker");
    // Propagate security headers added by blog middleware
    newHeaders.set("X-Content-Type-Options", "nosniff");
    newHeaders.set("X-Frame-Options", "DENY");
    newHeaders.set("Referrer-Policy", "strict-origin-when-cross-origin");

    return rewriter.transform(
      new Response(blogRes.body, {
        status: blogRes.status,
        headers: newHeaders,
      })
    );
  },
};
