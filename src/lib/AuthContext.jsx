import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

const AuthContext = createContext(null);

// status: 'loading' | 'signed_out' | 'checking_membership' | 'authorized' | 'not_authorized'
export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [status, setStatus] = useState("loading");
  const [member, setMember] = useState(null);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (!data.session) setStatus("signed_out");
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (!newSession) setStatus("signed_out");
    });

    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    let active = true;
    if (!session) return;

    setStatus("checking_membership");
    supabase
      .from("team_members")
      .select("email, name, role")
      .eq("email", session.user.email)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return;
        if (error || !data) {
          setMember(null);
          setStatus("not_authorized");
        } else {
          setMember(data);
          setStatus("authorized");
        }
      });

    return () => { active = false; };
  }, [session]);

  async function signOut() {
    await supabase.auth.signOut();
    setMember(null);
    setStatus("signed_out");
  }

  return (
    <AuthContext.Provider value={{ session, status, member, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
