import { createClerkClient } from "@clerk/backend";
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

type MappingEntry = {
  clerkUserId: string;
  email: string;
  role: string;
  supabaseUserId: string;
};

async function main() {
  const mapping: MappingEntry[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const page = await clerk.users.getUserList({ limit, offset });
    if (page.data.length === 0) break;

    for (const clerkUser of page.data) {
      const email = clerkUser.emailAddresses[0]?.emailAddress;
      if (!email) {
        console.error(`Skipping Clerk user ${clerkUser.id} — no email address`);
        continue;
      }
      const role = (clerkUser.publicMetadata?.role as string) ?? "technician";

      const { data, error } = await supabase.auth.admin.createUser({
        email,
        email_confirm: false, // false so Supabase requires the reset flow, not an auto-confirmed session
      });
      if (error) {
        console.error(`Failed to create Supabase user for ${email}:`, error.message);
        continue;
      }

      const { error: insertError } = await supabase.from("users").insert({
        id: data.user.id,
        email,
        role,
      });
      if (insertError) {
        console.error(`Failed to insert public.users row for ${email} (role="${role}"):`, insertError.message);
        continue;
      }

      mapping.push({
        clerkUserId: clerkUser.id,
        email,
        role,
        supabaseUserId: data.user.id,
      });

      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email);
      if (resetError) {
        console.error(`Failed to send reset email to ${email}:`, resetError.message);
      }
    }

    offset += limit;
  }

  writeFileSync("clerk-user-mapping.json", JSON.stringify(mapping, null, 2));
  console.log(`✓ exported ${mapping.length} users, mapping written to clerk-user-mapping.json`);
}

main();
