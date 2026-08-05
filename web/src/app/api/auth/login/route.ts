import { NextResponse } from "next/server";
import { LOCAL_AUTH_COOKIE, LOCAL_AUTH_TOKEN, isValidCredential } from "@/lib/local-auth";

function parseLoginPayload(rawBody: string, contentType: string): { username?: string; password?: string } {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return {};
  }

  if (contentType.includes("application/json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as { username?: unknown; password?: unknown };
      return {
        username: typeof parsed.username === "string" ? parsed.username : undefined,
        password: typeof parsed.password === "string" ? parsed.password : undefined,
      };
    } catch {
      const simpleMatch = (key: string) => {
        const match = trimmed.match(new RegExp(`${key}\\s*[:=]\\s*([^,}\\s]+)`, "i"));
        const value = match?.[1]?.trim().replace(/^['"]|['"]$/g, "");
        return value || undefined;
      };

      return {
        username: simpleMatch("username"),
        password: simpleMatch("password"),
      };
    }
  }

  const params = new URLSearchParams(trimmed);
  return {
    username: params.get("username") ?? undefined,
    password: params.get("password") ?? undefined,
  };
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const contentType = request.headers.get("content-type") ?? "";
    const body = parseLoginPayload(rawBody, contentType);

    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!isValidCredential(username, password)) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    const response = NextResponse.json({ success: true });
    response.cookies.set(LOCAL_AUTH_COOKIE, LOCAL_AUTH_TOKEN, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 30,
      path: "/",
    });

    return response;
  } catch (error) {
    console.error("[auth/login] Login failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Login failed" }, { status: 500 });
  }
}
