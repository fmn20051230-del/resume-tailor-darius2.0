"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  mergeServerConfig,
  saveSettings,
  SLOT_DISPLAY,
  type AutomationSettings,
} from "@/lib/automation/settings";

const OPENROUTER_KEY_STORAGE = "resume-tailor-openrouter-key";

export function SettingsPanel() {
  const [settings, setSettings] = useState<AutomationSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    const savedLocal = loadSettings();
    const legacyKey = localStorage.getItem(OPENROUTER_KEY_STORAGE);
    if (legacyKey && !savedLocal.apiKey) savedLocal.apiKey = legacyKey;

    fetch("/api/automation/config")
      .then((r) => r.json())
      .then((server) => setSettings(mergeServerConfig(savedLocal, server)))
      .catch(() => setSettings(savedLocal));
  }, []);

  function update(patch: Partial<AutomationSettings>) {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      if (patch.apiKey !== undefined) {
        const k = patch.apiKey.trim();
        if (k) localStorage.setItem(OPENROUTER_KEY_STORAGE, k);
        else localStorage.removeItem(OPENROUTER_KEY_STORAGE);
      }
      return next;
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function updateBaseResume(index: number, value: string) {
    const next = [...settings.baseResumes] as [string, string, string, string];
    next[index] = value;
    update({ baseResumes: next });
  }

  const keyConnected = settings.apiKey.trim().length > 8;

  return (
    <div className="art-settings">
      <header className="art-topbar">
        <div>
          <h1 className="art-page-title">Settings</h1>
          <p className="art-page-sub">Configure engine credentials, prompts, and resume slots</p>
        </div>
        {saved && <span className="art-saved-badge">Saved</span>}
      </header>

      <div className="art-settings-grid">
        <div className="art-settings-main">
          <section className="art-card">
            <h2 className="art-card-title">Engine Credentials</h2>
            <div className="art-form-row">
              <label className="art-label" htmlFor="username">Username</label>
              <input
                id="username"
                className="art-input"
                value={settings.username}
                onChange={(e) => update({ username: e.target.value })}
                placeholder="Your name"
              />
            </div>
            <div className="art-form-row">
              <label className="art-label" htmlFor="api-key">
                OpenRouter Key
                {keyConnected && <span className="art-connected">Connected</span>}
              </label>
              <input
                id="api-key"
                type="password"
                className="art-input"
                value={settings.apiKey}
                onChange={(e) => update({ apiKey: e.target.value })}
                placeholder="sk-or-v1-…"
                autoComplete="off"
              />
            </div>
            <div className="art-form-row">
              <label className="art-label" htmlFor="convert-api">
                ConvertAPI Secret (optional)
                {settings.convertApiSecret.trim().length > 4 && (
                  <span className="art-connected">Connected</span>
                )}
              </label>
              <input
                id="convert-api"
                type="password"
                className="art-input"
                value={settings.convertApiSecret}
                onChange={(e) => update({ convertApiSecret: e.target.value })}
                placeholder="Optional fallback — primary path is LibreOffice WASM"
                autoComplete="off"
              />
              <p className="art-hint">
                Not required. Deployed app converts DOCX→PDF with open-source LibreOffice
                WASM in the browser. ConvertAPI is only a fallback.
              </p>
            </div>
            <div className="art-form-row">
              <label className="art-label" htmlFor="output-dir">Output folder</label>
              <input
                id="output-dir"
                className="art-input"
                value={settings.outputDir}
                onChange={(e) => update({ outputDir: e.target.value })}
                placeholder="output"
              />
              <p className="art-hint">
                Folders saved as <code>01_Company_Position/</code> inside this directory (local only).
              </p>
            </div>
          </section>

          <section className="art-card">
            <div className="art-card-head">
              <h2 className="art-card-title">Extraction Prompt</h2>
              <button
                type="button"
                className="art-btn art-btn--ghost art-btn--sm"
                onClick={() => setShowPrompt((v) => !v)}
              >
                {showPrompt ? "Hide" : "Edit Prompt"}
              </button>
            </div>
            <p className="art-hint">
              Your existing OpenRouter JD extraction prompt — loaded and sent as-is, never modified.
            </p>
            {showPrompt && (
              <textarea
                className="art-textarea art-textarea--prompt"
                value={settings.extractionPrompt}
                onChange={(e) => update({ extractionPrompt: e.target.value })}
                placeholder="Paste your extraction prompt here…"
              />
            )}
          </section>

          <section className="art-card">
            <h2 className="art-card-title">Tailoring Prompt (Resume Tailor engine)</h2>
            <p className="art-hint">Shared prompt passed to the existing Resume Tailor unchanged.</p>
            <textarea
              className="art-textarea art-textarea--prompt"
              value={settings.tailoringPrompt}
              onChange={(e) => update({ tailoringPrompt: e.target.value })}
              placeholder="Your tailoring prompt…"
            />
          </section>

          <section className="art-card">
            <h2 className="art-card-title">Resume Slots (Engine Configuration)</h2>
            <p className="art-hint">
              Base resume in Markdown for each slot. Only <strong>Summary</strong>,{" "}
              <strong>Experience</strong>, and <strong>Skills</strong> from extracted JD are sent to tailor.
            </p>
            <div className="art-slot-grid">
              {SLOT_DISPLAY.map((slot) => (
                <div key={slot.index} className="art-slot-card">
                  <h3 className="art-slot-title">{slot.label}</h3>
                  <div className="art-slot-file">
                    <span className="art-slot-file-icon">MD</span>
                    <div>
                      <div className="art-slot-file-name">
                        {slot.shortLabel.replace(/\s+/g, "_")}_Base.md
                      </div>
                      <div className="art-slot-file-size">
                        {(settings.baseResumes[slot.index]?.length ?? 0) > 0
                          ? `${Math.round((settings.baseResumes[slot.index]?.length ?? 0) / 1024)} KB`
                          : "Not configured"}
                      </div>
                    </div>
                  </div>
                  <ul className="art-slot-parts">
                    <li>Summary</li>
                    <li>Experience</li>
                    <li>Skills</li>
                  </ul>
                  <textarea
                    className="art-textarea art-textarea--slot"
                    value={settings.baseResumes[slot.index] ?? ""}
                    onChange={(e) => updateBaseResume(slot.index, e.target.value)}
                    placeholder="Paste base resume markdown…"
                  />
                </div>
              ))}
            </div>
          </section>

          <section className="art-card">
            <h2 className="art-card-title">Advanced Options</h2>
            <label className="art-toggle-row">
              <span>Auto create folder per job</span>
              <input
                type="checkbox"
                checked={settings.autoCreateFolder}
                onChange={(e) => update({ autoCreateFolder: e.target.checked })}
              />
              <span className="art-toggle" />
            </label>
            <p className="art-hint">Folder name: [Number]_[Company]_[Position]</p>
          </section>
        </div>

        <aside className="art-settings-side">
          <section className="art-card">
            <h2 className="art-card-title">Resume Slots</h2>
            <ol className="art-slot-list">
              {SLOT_DISPLAY.map((s) => (
                <li key={s.index}>{s.label}</li>
              ))}
            </ol>
          </section>

          <section className="art-card">
            <h2 className="art-card-title">Quick Info</h2>
            <ul className="art-info-list">
              <li>Switching tabs does not stop an active batch</li>
              <li>Extraction prompt determines resume type (1–4)</li>
              <li>On Vercel, download the ZIP in your browser</li>
              <li>Failed jobs are skipped; batch continues</li>
            </ul>
          </section>

          <section className="art-card art-prompt-preview">
            <h2 className="art-card-title">Output per job</h2>
            <pre className="art-preview-box">
{`02_Snowflake_Data_Engineer/
  tailored_resume.docx
  tailored_resume.pdf
  job_url.txt
  extracted_jd.txt`}
            </pre>
          </section>
        </aside>
      </div>
    </div>
  );
}
