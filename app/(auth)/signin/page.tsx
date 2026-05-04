"use client";

import { signIn } from "next-auth/react";

export default function SignInPage() {
  return (
    <div className="min-h-[calc(100vh-44px)] flex items-center justify-center bg-neutral-950">
      <div className="bg-neutral-900 border border-neutral-800 rounded p-6 w-80">
        <div className="text-base font-semibold mb-1">Sign in</div>
        <div className="text-xs text-neutral-400 mb-4">
          Restricted to @thecruisemaps.com Google accounts.
        </div>
        <button
          onClick={() => signIn("google", { callbackUrl: "/coverage" })}
          className="w-full px-3 py-2 bg-emerald-700 text-white rounded text-sm"
        >
          Continue with Google
        </button>
      </div>
    </div>
  );
}
