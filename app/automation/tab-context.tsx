"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type AutomationTab = "dashboard" | "settings";

type TabContextValue = {
  tab: AutomationTab;
  setTab: (tab: AutomationTab) => void;
};

const TabContext = createContext<TabContextValue | null>(null);

export function useAutomationTab(): TabContextValue {
  const ctx = useContext(TabContext);
  if (!ctx) {
    throw new Error("useAutomationTab must be used within AutomationTabProvider");
  }
  return ctx;
}

function readTabFromUrl(): AutomationTab {
  if (typeof window === "undefined") return "dashboard";
  if (window.location.pathname.includes("/automation/settings")) return "settings";
  return new URLSearchParams(window.location.search).get("tab") === "settings"
    ? "settings"
    : "dashboard";
}

export function AutomationTabProvider({ children }: { children: ReactNode }) {
  const [tab, setTabState] = useState<AutomationTab>("dashboard");

  useEffect(() => {
    setTabState(readTabFromUrl());
  }, []);

  const setTab = useCallback((next: AutomationTab) => {
    setTabState(next);
    const url = next === "settings" ? "/automation?tab=settings" : "/automation";
    window.history.replaceState(null, "", url);
  }, []);

  return (
    <TabContext.Provider value={{ tab, setTab }}>{children}</TabContext.Provider>
  );
}
