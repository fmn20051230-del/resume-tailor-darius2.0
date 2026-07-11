"use client";

import Link from "next/link";
import { useAutomationTab, type AutomationTab } from "../tab-context";

const INTERNAL_NAV: { tab: AutomationTab; label: string; icon: string }[] = [
  { tab: "dashboard", label: "Dashboard", icon: "▦" },
  { tab: "settings", label: "Settings", icon: "⚙" },
];

export function AutomationSidebar() {
  const { tab, setTab } = useAutomationTab();

  return (
    <aside className="art-sidebar">
      <div className="art-brand">
        <div className="art-brand-icon">RT</div>
        <div>
          <div className="art-brand-title">Auto Resume Tailor</div>
          <div className="art-brand-beta">BETA</div>
        </div>
      </div>

      <nav className="art-nav">
        {INTERNAL_NAV.map((item) => {
          const active = tab === item.tab;
          return (
            <button
              key={item.tab}
              type="button"
              className={`art-nav-link${active ? " art-nav-link--active" : ""}`}
              onClick={() => setTab(item.tab)}
            >
              <span className="art-nav-icon">{item.icon}</span>
              {item.label}
            </button>
          );
        })}
        <Link href="/" className="art-nav-link">
          <span className="art-nav-icon">✎</span>
          Manual Tailor
        </Link>
      </nav>

      <div className="art-sidebar-foot">
        <p className="art-sidebar-note">
          Paste URLs on Dashboard. Settings stay on this page so an active batch is not interrupted.
        </p>
      </div>
    </aside>
  );
}
