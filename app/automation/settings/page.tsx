"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Old /automation/settings URL → same-page Settings tab (keeps batch runs alive). */
export default function AutomationSettingsRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/automation?tab=settings");
  }, [router]);

  return (
    <p className="art-page-sub" style={{ padding: 24 }}>
      Opening settings…
    </p>
  );
}
