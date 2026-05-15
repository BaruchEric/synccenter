import { useState } from "react";
import { getToken, setToken } from "@/lib/auth";

interface Props {
  children: React.ReactNode;
}

export function AuthGate({ children }: Props) {
  const [authed, setAuthed] = useState(() => !!getToken());
  const [value, setValue] = useState("");

  if (authed) return <>{children}</>;

  return (
    <div className="flex h-full items-center justify-center p-6">
      <form
        className="w-full max-w-md space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return;
          setToken(value.trim());
          setAuthed(true);
        }}
      >
        <div>
          <h1 className="text-xl font-semibold">SyncCenter</h1>
          <p className="text-sm text-slate-400">Paste the API bearer token to sign in. Stored in localStorage.</p>
        </div>
        <input
          type="password"
          autoFocus
          className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none"
          placeholder="Bearer token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          type="submit"
          className="w-full rounded bg-blue-600 px-3 py-2 text-sm font-medium hover:bg-blue-500 disabled:opacity-50"
          disabled={!value.trim()}
        >
          Sign in
        </button>
      </form>
    </div>
  );
}
