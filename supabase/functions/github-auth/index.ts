// Supabase Edge Function: Exchange GitHub OAuth token for Supabase JWT
// Deploy with: supabase functions deploy github-auth

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

interface GitHubUser {
  id: number;
  login: string;
  email: string | null;
}

interface RequestBody {
  github_token: string;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { github_token } = (await req.json()) as RequestBody;

    if (!github_token) {
      return new Response(
        JSON.stringify({ error: "github_token is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Verify GitHub token and get user info
    const ghResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${github_token}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!ghResponse.ok) {
      return new Response(
        JSON.stringify({ error: "Invalid GitHub token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const ghUser = (await ghResponse.json()) as GitHubUser;

    // Get email if not public
    let email = ghUser.email;
    if (!email) {
      const emailResponse = await fetch("https://api.github.com/user/emails", {
        headers: {
          Authorization: `Bearer ${github_token}`,
          Accept: "application/vnd.github+json",
        },
      });
      if (emailResponse.ok) {
        const emails = (await emailResponse.json()) as Array<{
          email: string;
          primary: boolean;
          verified: boolean;
        }>;
        const primary = emails.find((e) => e.primary && e.verified);
        email = primary?.email ?? emails[0]?.email ?? null;
      }
    }

    if (!email) {
      return new Response(
        JSON.stringify({ error: "Could not retrieve email from GitHub. Ensure email scope is granted." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Create Supabase admin client (uses service role key from env)
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // Find or create user by GitHub ID stored in user_metadata
    const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find(
      (u: { user_metadata?: { github_id?: number } }) =>
        u.user_metadata?.github_id === ghUser.id,
    );

    let userId: string;

    if (existingUser) {
      userId = existingUser.id;
      // Update metadata
      await supabaseAdmin.auth.admin.updateUserById(userId, {
        user_metadata: {
          github_id: ghUser.id,
          github_username: ghUser.login,
        },
      });
    } else {
      // Create new user
      const { data: newUser, error: createError } =
        await supabaseAdmin.auth.admin.createUser({
          email,
          email_confirm: true,
          user_metadata: {
            github_id: ghUser.id,
            github_username: ghUser.login,
          },
        });

      if (createError || !newUser.user) {
        return new Response(
          JSON.stringify({ error: `Failed to create user: ${createError?.message ?? "unknown"}` }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      userId = newUser.user.id;
    }

    // Generate JWT for the user
    const { data: tokenData, error: tokenError } =
      await supabaseAdmin.auth.admin.generateLink({
        type: "magiclink",
        email,
      });

    if (tokenError || !tokenData) {
      return new Response(
        JSON.stringify({ error: `Failed to generate token: ${tokenError?.message ?? "unknown"}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Sign in to get actual session tokens
    // Use the OTP from the magic link to create a session
    const { data: sessionData, error: sessionError } =
      await supabaseAdmin.auth.admin.generateLink({
        type: "magiclink",
        email,
      });

    // Create a session directly
    // Since we're the admin, we can create a session for the verified user
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Use the GoTrue admin API to create a session
    const sessionResponse = await fetch(
      `${supabaseUrl}/auth/v1/admin/generate_link`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
        },
        body: JSON.stringify({
          type: "magiclink",
          email,
        }),
      },
    );

    // For simplicity, we'll use the admin API to get a token pair
    // by verifying the magic link token server-side
    const linkData = await sessionResponse.json();
    const hashedToken = linkData?.properties?.hashed_token;

    if (!hashedToken) {
      // Fallback: return user ID and let client use it
      return new Response(
        JSON.stringify({
          access_token: "",
          refresh_token: "",
          user: { id: userId },
          error: "Session generation requires additional setup. User created successfully.",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Verify the OTP to get session tokens
    const verifyResponse = await fetch(
      `${supabaseUrl}/auth/v1/verify`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? serviceKey,
        },
        body: JSON.stringify({
          type: "magiclink",
          token: hashedToken,
        }),
      },
    );

    if (verifyResponse.ok) {
      const session = await verifyResponse.json();
      return new Response(
        JSON.stringify({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          user: { id: userId },
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // If verify fails, return what we have
    return new Response(
      JSON.stringify({
        access_token: "",
        refresh_token: "",
        user: { id: userId },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
