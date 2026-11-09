import {
  GoogleAuthProvider, createUserWithEmailAndPassword, onAuthStateChanged, sendEmailVerification, sendPasswordResetEmail,
  signInWithEmailAndPassword, signInWithPopup, signOut as fbSignOut, updateProfile, type User,
} from "firebase/auth";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { firebaseConfigured } from "../config/app";
import { api } from "./api";
import { getFirebaseAuth } from "./firebase";

export interface Membership {
  id: string; organizationId: string; organizationName: string; unitId: string | null; unitName: string | null;
  unitSlug: string | null; role: "owner" | "unit_admin" | "manager" | "barber"; permissions: string[];
}
export interface Me {
  user: { id: string; email: string | null; emailVerified: boolean; name: string | null };
  memberships: Membership[];
  customerLinks: number;
}

interface Ctx {
  ready: boolean;
  configured: boolean;
  user: User | null;
  me: Me | null;
  refreshMe: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  signInGoogle: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  resendVerification: () => Promise<void>;
  reloadUser: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthCtx = createContext<Ctx | null>(null);
export const useAuth = (): Ctx => {
  const c = useContext(AuthCtx);
  if (!c) throw new Error("AuthProvider ausente");
  return c;
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const auth = getFirebaseAuth();
  const [ready, setReady] = useState(!firebaseConfigured);
  const [user, setUser] = useState<User | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api<Me>("/me", { auth: true }));
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) await refreshMe();
      else setMe(null);
      setReady(true);
    });
  }, [auth, refreshMe]);

  const value = useMemo<Ctx>(() => {
    const need = () => {
      if (!auth) throw new Error("Login indisponível: configuração do Firebase pendente.");
      return auth;
    };
    return {
      ready, configured: firebaseConfigured, user, me, refreshMe,
      signIn: async (email, password) => { await signInWithEmailAndPassword(need(), email, password); },
      signUp: async (name, email, password) => {
        const cred = await createUserWithEmailAndPassword(need(), email, password);
        await updateProfile(cred.user, { displayName: name });
        await sendEmailVerification(cred.user);
      },
      signInGoogle: async () => { await signInWithPopup(need(), new GoogleAuthProvider()); },
      resetPassword: async (email) => { await sendPasswordResetEmail(need(), email); },
      resendVerification: async () => { if (auth?.currentUser) await sendEmailVerification(auth.currentUser); },
      reloadUser: async () => {
        if (auth?.currentUser) {
          await auth.currentUser.reload();
          await auth.currentUser.getIdToken(true); // novo token com email_verified atualizado
          await refreshMe();
          setUser(auth.currentUser);
        }
      },
      signOut: async () => { if (auth) await fbSignOut(auth); },
    };
  }, [auth, ready, user, me, refreshMe]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function authErrorMessage(e: unknown): string {
  const code = (e as { code?: string })?.code ?? "";
  const map: Record<string, string> = {
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/wrong-password": "E-mail ou senha incorretos.",
    "auth/user-not-found": "E-mail ou senha incorretos.",
    "auth/email-already-in-use": "Este e-mail já tem cadastro. Tente entrar.",
    "auth/weak-password": "Use uma senha com pelo menos 6 caracteres.",
    "auth/invalid-email": "E-mail inválido.",
    "auth/too-many-requests": "Muitas tentativas. Aguarde um pouco e tente de novo.",
    "auth/popup-closed-by-user": "Login cancelado.",
    "auth/network-request-failed": "Sem conexão. Verifique sua internet.",
  };
  return map[code] ?? (e instanceof Error ? e.message : "Não foi possível entrar.");
}
