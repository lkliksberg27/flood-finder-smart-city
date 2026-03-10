import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password required" },
        { status: 400 }
      );
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;

    if (!url || !key) {
      return NextResponse.json(
        { error: "Server config missing", hasUrl: !!url, hasKey: !!key },
        { status: 500 }
      );
    }

    const supabase = createClient(url, key);

    // Create user with auto-confirmed email
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (error) {
      return NextResponse.json(
        { error: error.message, code: error.status },
        { status: 400 }
      );
    }

    return NextResponse.json({
      message: "Account created successfully. You can now sign in.",
      userId: data.user.id,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Setup failed", detail: message },
      { status: 500 }
    );
  }
}
