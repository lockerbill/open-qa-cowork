import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  EMPTY_AUTH,
  MANAGE_ROLES,
  type AuthState,
  type Settings,
} from '../shared/messages.js';
import { getAuth, saveAuth, clearAuth } from '../shared/storage.js';
import * as bg from '../sidepanel/chrome-client.js';
import {
  ApiClientError,
  createProvider,
  listProviders,
  listWorkspaces,
  login,
  register,
  setDefaultProvider,
  validateProvider,
  type ProviderConfigView,
} from '../sidepanel/backend.js';

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

      <AccountSection backendUrl={settings.backendUrl} />

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

/** Sign in / register and (when signed in) manage the workspace AI provider. */
function AccountSection({ backendUrl }: { backendUrl: string }) {
  const [auth, setAuth] = useState<AuthState>(EMPTY_AUTH);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getAuth().then(setAuth);
  }, []);

  const applyAuth = async (next: AuthState) => {
    await saveAuth(next);
    setAuth(next);
  };

  const doRegister = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await register(backendUrl, { email, password });
      await applyAuth({
        ...EMPTY_AUTH,
        token: res.token,
        userEmail: res.user.email,
        currentWorkspaceId: res.workspace?.id ?? null,
        currentWorkspaceName: res.workspace?.name ?? null,
        currentWorkspaceRole: res.workspace?.role ?? null,
      });
      setPassword('');
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const doLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await login(backendUrl, { email, password });
      const { workspaces } = await listWorkspaces(backendUrl, res.token);
      const ws = workspaces[0];
      await applyAuth({
        ...EMPTY_AUTH,
        token: res.token,
        userEmail: res.user.email,
        currentWorkspaceId: ws?.id ?? null,
        currentWorkspaceName: ws?.name ?? null,
        currentWorkspaceRole: ws?.role ?? null,
      });
      setPassword('');
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await clearAuth();
    setAuth(EMPTY_AUTH);
  };

  if (!auth.token) {
    return (
      <div className="section">
        <h3>Account</h3>
        <p className="muted">Sign in to use a workspace BYO LLM provider through the gateway.</p>
        <input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          type="password"
          placeholder="Password (min 8 chars)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="primary" disabled={busy} onClick={doLogin}>
            Log in
          </button>
          <button className="ghost" disabled={busy} onClick={doRegister}>
            Register
          </button>
        </div>
        {error && <p className="err">{error}</p>}
      </div>
    );
  }

  return (
    <div className="section">
      <h3>Account</h3>
      <p>
        Signed in as <strong>{auth.userEmail}</strong>
      </p>
      <p className="muted">
        Workspace: {auth.currentWorkspaceName ?? '—'} ({auth.currentWorkspaceRole ?? 'member'})
      </p>
      <button className="ghost" onClick={logout}>
        Log out
      </button>
      {auth.currentWorkspaceId && <ProviderSection backendUrl={backendUrl} auth={auth} />}
    </div>
  );
}

/** Manage (owner/admin) or view (tester/viewer) the workspace's LLM providers. */
function ProviderSection({ backendUrl, auth }: { backendUrl: string; auth: AuthState }) {
  const workspaceId = auth.currentWorkspaceId!;
  const token = auth.token!;
  const canManage = MANAGE_ROLES.includes(auth.currentWorkspaceRole ?? '');

  const [providers, setProviders] = useState<ProviderConfigView[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    displayName: '',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelName: '',
    apiKey: '',
  });

  const refresh = useCallback(async () => {
    try {
      const res = await listProviders(backendUrl, token, workspaceId);
      setProviders(res.providers);
    } catch (e) {
      setError(messageOf(e));
    }
  }, [backendUrl, token, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addProvider = async () => {
    setError(null);
    setStatus(null);
    try {
      await createProvider(backendUrl, token, workspaceId, {
        displayName: form.displayName,
        baseUrl: form.baseUrl,
        modelName: form.modelName,
        apiKey: form.apiKey,
      });
      setForm((f) => ({ ...f, apiKey: '', displayName: '' }));
      setStatus('Provider saved.');
      await refresh();
    } catch (e) {
      setError(messageOf(e));
    }
  };

  const test = async (id: string) => {
    setError(null);
    setStatus('Testing…');
    try {
      const res = await validateProvider(backendUrl, token, workspaceId, id);
      setStatus(res.message);
      await refresh();
    } catch (e) {
      setError(messageOf(e));
    }
  };

  const makeDefault = async (id: string) => {
    setError(null);
    try {
      await setDefaultProvider(backendUrl, token, workspaceId, id);
      await refresh();
    } catch (e) {
      setError(messageOf(e));
    }
  };

  return (
    <div style={{ marginTop: 16 }}>
      <h3>AI Provider</h3>
      <ul className="tight">
        {providers.length === 0 && <li className="muted">None configured yet</li>}
        {providers.map((p) => (
          <li key={p.id}>
            <strong>{p.displayName}</strong> — {p.modelName}{' '}
            {p.isWorkspaceDefault && <span className="chip ok">default</span>}{' '}
            <span className="muted">[{p.validationStatus}]</span>
            {canManage && (
              <span className="row" style={{ display: 'inline-flex', gap: 6, marginLeft: 8 }}>
                <button className="ghost" onClick={() => test(p.id)}>
                  Test
                </button>
                {!p.isWorkspaceDefault && (
                  <button className="ghost" onClick={() => makeDefault(p.id)}>
                    Set default
                  </button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>

      {canManage ? (
        <>
          <p className="muted">Add an OpenAI-compatible provider (the API key is stored only on the gateway).</p>
          <input
            type="text"
            placeholder="Display name (e.g. OpenRouter)"
            value={form.displayName}
            onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
          />
          <input
            type="text"
            placeholder="Base URL (e.g. https://openrouter.ai/api/v1)"
            value={form.baseUrl}
            onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
          />
          <input
            type="text"
            placeholder="Model (e.g. anthropic/claude-sonnet-4)"
            value={form.modelName}
            onChange={(e) => setForm((f) => ({ ...f, modelName: e.target.value }))}
          />
          <input
            type="password"
            placeholder="API key"
            value={form.apiKey}
            onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" onClick={addProvider}>
              Save provider
            </button>
          </div>
        </>
      ) : (
        <p className="muted">AI provider is configured by your workspace admin. You cannot view the API key.</p>
      )}
      {status && <p className="muted">{status}</p>}
      {error && <p className="err">{error}</p>}
    </div>
  );
}

function messageOf(e: unknown): string {
  if (e instanceof ApiClientError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
