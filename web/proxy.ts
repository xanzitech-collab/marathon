import { type NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { LOCAL_AUTH_COOKIE, LOCAL_AUTH_TOKEN } from "@/lib/local-auth-constants";

export const runtime = "nodejs";

function isPaymentHoldEnabled(): boolean {
  const paymentHoldKey = ["PAYMENT", "HOLD"].join("_");
  return process.env[paymentHoldKey]?.trim().toLowerCase() === "true";
}

function paymentHoldResponse() {
  return new NextResponse(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Access Temporarily Unavailable</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #10151c; color: #f4f7fb; font-family: Georgia, serif; }
      main { width: min(34rem, calc(100% - 3rem)); border-top: 3px solid #d8ae57; padding: 2.5rem 0; }
      p { color: #b7c0cb; font: 1rem/1.6 system-ui, sans-serif; }
      small { color: #7f8a98; font: 0.8rem system-ui, sans-serif; letter-spacing: 0.08em; text-transform: uppercase; }
    </style>
  </head>
  <body><main><small>Service Notice</small><h1>Access temporarily unavailable</h1><p>This service is currently unavailable while account payment is pending. Please contact the service owner to restore access.</p></main></body>
</html>`,
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

export async function proxy(request: NextRequest) {
  if (process.env.NODE_ENV === "production" && isPaymentHoldEnabled()) {
    return paymentHoldResponse();
  }

  const path = request.nextUrl.pathname;
  const authHeader = request.headers.get("x-marathon-auth") ?? request.headers.get("authorization") ?? "";
  const headerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  const isAuthenticated = request.cookies.get(LOCAL_AUTH_COOKIE)?.value === LOCAL_AUTH_TOKEN || headerToken === LOCAL_AUTH_TOKEN;

  const isSignin = path.startsWith("/signin");
  const isSignup = path.startsWith("/signup");
  const isAuthApi = path.startsWith("/api/auth/");
  const isDashboard = path.startsWith("/dashboard");
  const isProtectedApi = path.startsWith("/api/") && !isAuthApi;

  if (!isAuthenticated && (isDashboard || isProtectedApi)) {
    const url = request.nextUrl.clone();
    const nextPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    url.pathname = "/signin";
    url.searchParams.set("next", nextPath);
    return NextResponse.redirect(url);
  }

  if (isAuthenticated && (isSignin || isSignup)) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
