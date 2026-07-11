import type { Metadata } from "next";
import "./automation.css";
import { AutomationSidebar } from "./components/Sidebar";

export const metadata: Metadata = {
  title: "Auto Resume Tailor",
  description: "Bulk automate resume tailoring from job URLs",
};

export default function AutomationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="art-app">
      <AutomationSidebar />
      <div className="art-content">{children}</div>
    </div>
  );
}
