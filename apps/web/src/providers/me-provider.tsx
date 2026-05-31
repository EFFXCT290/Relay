"use client";

import { createContext, useContext } from "react";

type MeContextValue = {
  userId: string;
  username: string;
};

export const MeContext = createContext<MeContextValue | null>(null);

export function useMe(): MeContextValue {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error("useMe must be used inside AppShell");
  return ctx;
}
