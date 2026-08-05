import { type NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { LOCAL_AUTH_COOKIE, LOCAL_AUTH_TOKEN } from "@/lib/local-auth-constants";

export async function proxy(request: NextRequest) {
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
