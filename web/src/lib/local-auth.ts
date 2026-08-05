import { cookies, headers } from "next/headers";

export {
  LOCAL_AUTH_COOKIE,
  LOCAL_AUTH_TOKEN,
  LOCAL_USERNAME,
  LOCAL_PASSWORD,
  LOCAL_AUTH_EMAIL,
  isValidCredential,
} from "@/lib/local-auth-constants";
import { LOCAL_AUTH_COOKIE, LOCAL_AUTH_TOKEN } from "@/lib/local-auth-constants";

export async function hasLocalSession() {
  const cookieStore = await cookies();
  if (cookieStore.get(LOCAL_AUTH_COOKIE)?.value === LOCAL_AUTH_TOKEN) {
    return true;
  }

  const headerStore = await headers();
  const authHeader = headerStore.get("x-marathon-auth") ?? headerStore.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  return token === LOCAL_AUTH_TOKEN;
}
