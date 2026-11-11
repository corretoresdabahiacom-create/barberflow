import { createContext, useContext } from "react";

export interface UnitInfo {
  id: string; name: string; slug: string; address: string | null; phone: string | null; timezone: string; status: string;
  auto_confirm: number; min_notice_min: number; max_days_ahead: number; slot_step_min: number; cancel_window_min: number;
  city: string | null; state: string | null; description: string | null; listed: number;
}
export interface AdminCtx {
  orgId: string;
  orgName: string;
  units: UnitInfo[];
  perms: Set<string>;
  can: (p: string) => boolean;
  reloadUnits: () => Promise<void>;
}
export const AdminContext = createContext<AdminCtx | null>(null);
export const useAdmin = (): AdminCtx => {
  const c = useContext(AdminContext);
  if (!c) throw new Error("contexto do painel ausente");
  return c;
};
export const orgPath = (orgId: string, p: string) => `/orgs/${orgId}${p}`;
