import { hasLocalSession, LOCAL_AUTH_EMAIL } from "@/lib/local-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export class AppError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// Avoid calling the admin listUsers API on every single request — this is a
// single hardcoded local user whose id never changes for the life of the process.
const globalState = globalThis as typeof globalThis & { __marathonLocalUserId?: string };

async function getOrCreateLocalUserId(supabase: ReturnType<typeof createAdminClient>) {
  if (globalState.__marathonLocalUserId) {
    return globalState.__marathonLocalUserId;
  }

  const { data: listed, error: listError } = await supabase.auth.admin.listUsers();
  if (listError) {
    throw new AppError(`Unable to list auth users: ${listError.message}`, 500);
  }

  const existing = listed.users.find((user) => user.email?.toLowerCase() === LOCAL_AUTH_EMAIL.toLowerCase());
  if (existing) {
    globalState.__marathonLocalUserId = existing.id;
    return existing.id;
  }

  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email: LOCAL_AUTH_EMAIL,
    password: crypto.randomUUID(),
    email_confirm: true,
    user_metadata: { source: "local-hardcoded-login" },
  });

  if (createError || !created.user) {
    throw new AppError(
      `Unable to create local auth user: ${createError?.message ?? "unknown error"}`,
      500,
    );
  }

  globalState.__marathonLocalUserId = created.user.id;
  return created.user.id;
}

export async function requireUser() {
  const isAuthenticated = await hasLocalSession();
  if (!isAuthenticated) {
    throw new AppError("Unauthorized", 401);
  }

  let supabase;
  try {
    supabase = createAdminClient();
  } catch {
    throw new AppError(
      "Server is missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL. Update your environment variables.",
      500,
    );
  }

  const userId = await getOrCreateLocalUserId(supabase);

  return { supabase, user: { id: userId } };
}
