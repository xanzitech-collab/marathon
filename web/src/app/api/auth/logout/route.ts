import { NextResponse } from "next/server";
import { LOCAL_AUTH_COOKIE } from "@/lib/local-auth";

export async function POST() {
  const response = NextResponse.json({ success: true });
  response.cookies.set(LOCAL_AUTH_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/",
  });
  return response;
}
