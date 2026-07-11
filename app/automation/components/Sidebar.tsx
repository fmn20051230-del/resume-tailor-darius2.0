"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/automation", label: "Dashboard", icon: "▦" },
  { href: "/automation/settings", label: "Settings", icon: "⚙" },
  { href: "/", label: "Manual Tailor", icon: "✎" },
] as const;

export function AutomationSidebar() {
  const pathname = usePathname();

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
        {NAV.map((item) => {
          const active =
            item.href === "/automation"
              ? pathname === "/automation"
              : pathname.startsWith(item.href) && item.href !== "/";
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`art-nav-link${active ? " art-nav-link--active" : ""}`}
            >
              <span className="art-nav-icon">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="art-sidebar-foot">
        <p className="art-sidebar-note">
          Paste URLs on Dashboard → each job saves a folder with DOCX, PDF, URL, and extracted JD.
        </p>
      </div>
    </aside>
  );
}
