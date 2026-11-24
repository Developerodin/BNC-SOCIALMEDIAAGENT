import { NextResponse, type NextRequest } from "next/server";

const SHOP_RE = /^[a-z0-9-]+\.myshopify\.com$/;

export function proxy(req: NextRequest) {
  const { pathname, searchParams, search } = req.nextUrl;
  // Shopify opens the app URL at the root; send it to the embedded app with its query intact.
  if (pathname === "/" && (searchParams.has("shop") || searchParams.has("host"))) {
    return NextResponse.redirect(new URL(`/app${search}`, req.url));
  }
  const shop = searchParams.get("shop");
  const embedded = pathname === "/app" || pathname.startsWith("/app/");
  // The hosted chat page (/chat/<shop>) is made to be embedded by any site (docs/embed.md).
  const ancestors = pathname.startsWith("/chat/")
    ? "*"
    : embedded && shop && SHOP_RE.test(shop)
      ? `https://${shop} https://admin.shopify.com`
      : "'none'";
  const res = NextResponse.next();
  res.headers.set("Content-Security-Policy", `frame-ancestors ${ancestors}`);
  return res;
}

export const config = {
  // HTML pages only: skip API routes and static assets.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
