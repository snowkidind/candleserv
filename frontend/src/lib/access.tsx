/**
 * Access context — exposes whether the current viewer may MUTATE state
 * (`canModify`). This is the single gate every control reads: an authenticated
 * *view-only* user (logged in, but without CAN_MODIFY_CANDLESERV) gets the same
 * read-only surface the public demo does.
 *
 * `canModify = !demo && perms.CAN_MODIFY_CANDLESERV`. It mirrors the backend's
 * `requirePerm("CAN_MODIFY_CANDLESERV")` guards on the mutation routes — the UI
 * never offers a control the server would reject.
 *
 * Fail closed: default `false` (read-only) until `/monitor/me` confirms the
 * permission. A demo viewer never calls /me (no session); the injected flag
 * settles it synchronously.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getMe } from "./api";
import { isDemo } from "./demo";

interface Access {
  canModify: boolean;
  ready: boolean;   // /me resolved (or demo, which resolves immediately)
}

const AccessContext = createContext<Access>({ canModify: false, ready: false });

export function AccessProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Access>({ canModify: false, ready: false });

  useEffect(() => {
    // Demo: public, no session. Always read-only; skip the /me call (it would 401).
    if (isDemo()) { setState({ canModify: false, ready: true }); return; }
    // Authed: the permission map is the source of truth. A 401 here means the
    // session is gone — api.ts redirects to /login (suppressed in demo).
    getMe()
      .then(me => setState({
        canModify: !me.isDemo && !!me.perms.CAN_MODIFY_CANDLESERV,
        ready: true,
      }))
      .catch(() => setState({ canModify: false, ready: true }));
  }, []);

  return <AccessContext.Provider value={state}>{children}</AccessContext.Provider>;
}

export function useAccess(): Access {
  return useContext(AccessContext);
}

/** Convenience: just the mutation gate. */
export function useCanModify(): boolean {
  return useContext(AccessContext).canModify;
}
