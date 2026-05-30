/**
 * Cloudflare Pages Function: /blog/*
 *
 * Automatically deployed when you push to the ordo-landing repo.
 * Routes all /blog/* requests to app.nidero.se and replaces
 * the blog's <header> and <footer> with the landing page's own HTML.
 */

const BLOG_ORIGIN = "https://app.nidero.se";
const LANDING_ORIGIN = "https://www.nidero.se";
const SHELL_CACHE_TTL = 300;

async function fetchLandingShell(ctx) {
  const cache = caches.default;
  const cacheKey = new Request(LANDING_ORIGIN + "/__shell__");
  const cached = await cache.match(cacheKey);
  if (cached) return cached.text();

  const res = await fetch(LANDING_ORIGIN + "/", {
    headers: { "User-Agent": "NideroPages/1.0" },
  });
  if (!res.ok) return null;

  const html = await res.text();
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(html, {
        headers: { "Cache-Control": `public, max-age=${SHELL_CACHE_TTL}` },
      })
    )
  );
  return html;
}

function extractTag(html, tag) {
  const open = new RegExp(`<${tag}[^>]*>`, "i");
  const close = new RegExp(`<\\/${tag}>`, "i");
  const startMatch = open.exec(html);
  if (!startMatch) return null;
  const start = startMatch.index;
  const endMatch = close.exec(html.slice(start));
  if (!endMatch) return null;
  return html.slice(start, start + endMatch.index + endMatch[0].length);
}

export async function onRequest(ctx) {
  const { request, next } = ctx;
  const url = new URL(request.url);

  // Proxy to Railway
  const blogUrl = BLOG_ORIGIN + url.pathname + url.search;
  const blogRes = await fetch(blogUrl, {
    headers: {
      ...Object.fromEntries(request.headers),
      Host: new URL(BLOG_ORIGIN).host,
      "X-Forwarded-Host": url.host,
    },
    redirect: "follow",
  });

  // Non-HTML (images etc.) — pass through unchanged
  const ct = blogRes.headers.get("Content-Type") || "";
  if (!ct.includes("text/html")) {
    return new Response(blogRes.body, {
      status: blogRes.status,
      headers: blogRes.headers,
    });
  }

  // Fetch landing page shell for nav/footer
  const landingHtml = await fetchLandingShell(ctx);
  if (!landingHtml) return blogRes;

  const rawHeader = extractTag(landingHtml, "header");
  const rawFooter = extractTag(landingHtml, "footer");

  // Fix anchor links (#funktioner → /#funktioner) so they work on /blog/* paths
  const fixedHeader = rawHeader?.replace(/href="#/g, 'href="/#') ?? null;

  let rewriter = new HTMLRewriter();
  if (fixedHeader) {
    rewriter = rewriter.on("header.topbar", {
      element(el) { el.replace(fixedHeader, { html: true }); },
    });
  }
  if (rawFooter) {
    rewriter = rewriter.on("footer.footer", {
      element(el) { el.replace(rawFooter, { html: true }); },
    });
  }

  const headers = new Headers(blogRes.headers);
  headers.set("X-Proxied-By", "NideroPages");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  return rewriter.transform(
    new Response(blogRes.body, { status: blogRes.status, headers })
  );
}
