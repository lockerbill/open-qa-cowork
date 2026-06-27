import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, type Settings } from '../shared/messages.js';
import * as bg from '../sidepanel/chrome-client.js';

export function Options() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [newOrigin, setNewOrigin] = useState('');

  useEffect(() => {
    void bg.getSettings().then(setSettings);
  }, []);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
    setSaved(false);
  };

  const save = async () => {
    await bg.saveSettings(settings);
    setSaved(true);
  };

  const addOrigin = async () => {
    const origin = newOrigin.trim().replace(/\/$/, '');
    if (!origin) return;
    const res = await bg.addAllowlistOrigin(origin);
    if (res.ok) {
      setSettings(await bg.getSettings());
      setNewOrigin('');
    }
  };

  return (
    <div style={{ maxWidth: 560, margin: '24px auto', padding: 16 }}>
      <h1 style={{ fontSize: 18 }}>QA Copilot — Settings</h1>

      <div className="section">
        <h3>Backend URL</h3>
        <input
          type="text"
          value={settings.backendUrl}
          onChange={(e) => update('backendUrl', e.target.value)}
        />

        <h3>Environment label</h3>
        <input
          type="text"
          value={settings.environment}
          onChange={(e) => update('environment', e.target.value)}
        />

        <h3>Safety</h3>
        <label className="row">
          <input
            type="checkbox"
            checked={settings.noDestructiveMode}
            onChange={(e) => update('noDestructiveMode', e.target.checked)}
          />
          No-destructive mode (advise/confirm before submit, delete, payment)
        </label>

        <h3>Allowlisted origins</h3>
        <p className="muted">
          QA Copilot only runs on localhost and the origins you add here (spec §15).
        </p>
        <ul className="tight">
          {settings.allowlist.length === 0 && <li className="muted">None yet</li>}
          {settings.allowlist.map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ul>
        <div className="row">
          <input
            type="text"
            placeholder="https://staging.example.com"
            value={newOrigin}
            onChange={(e) => setNewOrigin(e.target.value)}
          />
          <button className="ghost" onClick={addOrigin}>
            Add &amp; grant
          </button>
        </div>

        <div className="row" style={{ marginTop: 16 }}>
          <button className="primary" onClick={save}>
            Save settings
          </button>
          {saved && <span className="chip ok">Saved</span>}
        </div>
      </div>
    </div>
  );
}
