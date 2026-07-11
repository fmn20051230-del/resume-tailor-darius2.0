"use client";

import { AutomationTabProvider, useAutomationTab } from "./tab-context";
import { AutomationSidebar } from "./components/Sidebar";
import { SettingsPanel } from "./components/SettingsPanel";
import type { ReactNode } from "react";

function AutomationShellInner({ children }: { children: ReactNode }) {
  const { tab } = useAutomationTab();

  return (
    <div className="art-app">
      <AutomationSidebar />
      <div className="art-content">
        {/* Keep dashboard mounted while on Settings so batch runs keep streaming. */}
        <div
          className={tab === "dashboard" ? undefined : "art-tab-panel--hidden"}
          aria-hidden={tab !== "dashboard"}
        >
          {children}
        </div>
        <div
          className={tab === "settings" ? undefined : "art-tab-panel--hidden"}
          aria-hidden={tab !== "settings"}
        >
          <SettingsPanel />
        </div>
      </div>
    </div>
  );
}

export function AutomationShell({ children }: { children: ReactNode }) {
  return (
    <AutomationTabProvider>
      <AutomationShellInner>{children}</AutomationShellInner>
    </AutomationTabProvider>
  );
}
