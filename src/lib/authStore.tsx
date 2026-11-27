import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabaseClient';
import { useSessionTimeout } from '@/hooks/useSessionTimeout';

interface AuthStore {
  user: User | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthStore | null>(null);

const DEV_AUTH_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DEV_AUTH_USER_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Dev-only stub user for headless browser verification (Playwright / CDP):
 * open `http://localhost:<port>/?devAuth=1` to render the
 * signed-in shell without a Supabase session or credentials. Requests still
 * go through RLS with the anon key.
 * `import.meta.env.DEV` is statically `false` in `vite build`, so this is
 * stripped from production; the vitest run and non-localhost hosts are excluded.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function readDevAuthUser(): User | null {
  if (!import.meta.env.DEV || import.meta.env.MODE === 'test') return null;
  if (typeof location === 'undefined' || !DEV_AUTH_HOSTS.has(location.hostname)) return null;
  const flag = new URLSearchParams(location.search).get('devAuth');
  if (flag !== '1') return null;
  return {
    id: DEV_AUTH_USER_ID,
    aud: 'authenticated',
    email: 'dev@localhost',
    app_metadata: {},
    user_metadata: {},
    created_at: new Date(0).toISOString(),
  };
}

/**
 * True for the `?devAuth` stub, which has no Supabase session to read with.
 * Checks the id, not the URL: client-side navigation drops `?devAuth` while
 * the stub stays signed in. Statically `false` in `vite build`.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function isDevAuthUser(userId: string): boolean {
  return import.meta.env.DEV && userId === DEV_AUTH_USER_ID;
}

export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const devUser = readDevAuthUser();
    if (devUser) {
      setUser(devUser);
      setLoading(false);
      return;
    }

    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (active) {
        setUser(data.session?.user ?? null);
        setLoading(false);
      }
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const signOut = useCallback(async () => {
    const devAuthActive = readDevAuthUser() !== null;
    setUser(null);
    if (devAuthActive) {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.delete('devAuth');
      window.history.replaceState(window.history.state, '', nextUrl);
      return;
    }
    await supabase.auth.signOut();
  }, []);

  useSessionTimeout(user?.id ?? null, signOut);

  const value = useMemo(() => ({ user, loading, signOut }), [user, loading, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthStore {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
