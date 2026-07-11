import type { Metadata } from "next";
import "./automation.css";
import { AutomationShell } from "./AutomationShell";

export const metadata: Metadata = {
  title: "Auto Resume Tailor",
  description: "Bulk automate resume tailoring from job URLs",
};

export default function AutomationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AutomationShell>{children}</AutomationShell>;
}
