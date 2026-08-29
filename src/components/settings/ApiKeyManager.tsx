import { useState, type CSSProperties } from 'react';
import { useApi } from '@lib/swr';
import { Spinner } from '../ui/Spinner';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Dialog } from '../ui/Dialog';

interface ApiKey {
  id: string;
  name: string;
  keyPreview: string;
  createdAt: string;
  lastUsedAt: string | null;
  isActive: boolean;
  expiresAt: string | null;
}

interface NewKeyResponse {
  id: string;
  key: string;
  name: string;
}

const EXPIRATION_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
];

export default function ApiKeyManager() {
  const { data: quotaData } = useApi<{ limits?: { apiKeys?: number } }>('/api/quotas/usage');
  const apiDisabled = quotaData?.limits?.apiKeys === 0;

  const { data: _keyData, error: _keyError, isLoading: loading, mutate: mutateKeys } = useApi<{ keys?: ApiKey[] } | ApiKey[]>(apiDisabled ? null : '/api/api-keys');
  const keys = Array.isArray(_keyData) ? _keyData : _keyData?.keys ?? [];
  const [error, setError] = useState<string | null>(_keyError?.message ?? null);

  // Generate form state
  const [showGenerate, setShowGenerate] = useState(false);
  const [newName, setNewName] = useState('');
  const [expiration, setExpiration] = useState('90');
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // Newly created key display
  const [newKey, setNewKey] = useState<NewKeyResponse | null>(null);
  const [copied, setCopied] = useState(false);

  // Revoke confirmation
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  if (apiDisabled) return null;

  async function generateKey() {
    if (!newName.trim()) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          expires_in_days: expiration === 'never' ? null : Number(expiration),
        }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const msg = errBody?.error?.message || errBody?.error?.hint || errBody?.error || 'Failed to generate API key';
        throw new Error(typeof msg === 'string' ? msg : 'Failed to generate API key');
      }
      const data: NewKeyResponse = await res.json();
      setNewKey(data);
      setShowGenerate(false);
      setNewName('');
      setExpiration('90');
      setGenerateError(null);
      mutateKeys(undefined, { revalidate: true });
    } catch (err: any) {
      setGenerateError(err.message ?? 'Failed to generate key');
    } finally {
      setGenerating(false);
    }
  }

  async function revokeKey(id: string) {
    setRevoking(true);
    setRevokeError(null);
    try {
      const res = await fetch(`/api/api-keys/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody?.error?.message || errBody?.error || 'Failed to revoke key');
      }
      setRevokeTarget(null);
      mutateKeys(undefined, { revalidate: true });
    } catch (err: any) {
      setRevokeError(err.message ?? 'Failed to revoke key');
    } finally {
      setRevoking(false);
    }
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  function formatDate(dateStr: string | null): string {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  function expirationLabel(dateStr: string | null): { text: string; color: string } | null {
    if (!dateStr) return null;
    const diff = new Date(dateStr).getTime() - Date.now();
    if (diff <= 0) return { text: 'Expired', color: 'var(--color-error)' };
    const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
    if (days <= 7) return { text: `${days}d left`, color: 'var(--color-warning, #D97706)' };
    return { text: `${days}d left`, color: 'var(--stone-400)' };
  }

  // -- Styles --

  const sectionStyle: CSSProperties = {
    marginBottom: 0,
  };

  const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '16px',
  };

  const warningStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    padding: '12px 16px',
    background: 'var(--color-warning-bg)',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    fontSize: 'var(--text-sm)',
    color: '#92400E',
    lineHeight: 'var(--leading-relaxed)',
    marginBottom: '4px',
  };

  const tableStyle: CSSProperties = {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 'var(--text-sm)',
  };

  const thStyle: CSSProperties = {
    textAlign: 'left',
    padding: '12px',
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    color: 'var(--stone-400)',
    textTransform: 'uppercase',
    letterSpacing: 'var(--tracking-wider)',
    background: 'var(--stone-50)',
  };

  const tdStyle: CSSProperties = {
    padding: '12px',
    color: 'var(--stone-700)',
    verticalAlign: 'middle',
  };

  const newKeyBoxStyle: CSSProperties = {
    padding: '16px',
    background: 'var(--color-success-bg)',
    border: 'none',
    borderRadius: 'var(--radius-lg)',
    marginBottom: '4px',
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div style={sectionStyle}>
      <div style={headerStyle}>
        <div>
          <h3 style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--text-lg)',
            color: 'var(--stone-900)',
            marginBottom: '2px',
          }}>
            API Keys
          </h3>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-400)' }}>
            Manage API keys for programmatic access.
          </p>
        </div>
        <Button
          variant="primary"
          size="md"
          onClick={() => { setShowGenerate(true); setNewKey(null); }}
        >
          Generate New Key
        </Button>
      </div>

      {/* Warning */}
      <div style={warningStyle}>
        API keys provide full access to your account. Keep them secret and rotate them regularly.
        Never share keys in public repositories or client-side code.
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: '12px 16px',
          background: 'var(--color-error-bg)',
          color: '#991B1B',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--text-sm)',
          marginBottom: '16px',
        }}>
          {error}
        </div>
      )}

      {/* Newly created key display */}
      {newKey && (
        <div style={newKeyBoxStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#10B981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
            </svg>
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: '#065F46' }}>
              API key "{newKey.name}" created successfully
            </span>
          </div>
          <p style={{ fontSize: 'var(--text-xs)', color: '#065F46', marginBottom: '10px' }}>
            Copy this key now. You will not be able to see it again.
          </p>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 14px',
            background: '#FFFFFF',
            borderRadius: 'var(--radius-md)',
            border: 'none',
          }}>
            <code style={{
              flex: 1,
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-sm)',
              color: 'var(--stone-800)',
              wordBreak: 'break-all',
              userSelect: 'all',
            }}>
              {newKey.key}
            </code>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => copyToClipboard(newKey.key)}
            >
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>
        </div>
      )}

      {/* Key list */}
      {keys.length === 0 ? (
        <div style={{
          padding: '32px',
          textAlign: 'center',
          background: 'var(--stone-50)',
          borderRadius: 'var(--radius-lg)',
          border: 'none',
        }}>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--stone-400)', fontWeight: 500 }}>
            No API keys yet
          </p>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--stone-300)', marginTop: '4px' }}>
            Generate a key to access the openPublish API programmatically.
          </p>
        </div>
      ) : (
        <div className="r-table-scroll" style={{ overflowX: 'auto' }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Key</th>
                <th style={thStyle}>Created</th>
                <th style={thStyle}>Last Used</th>
                <th style={thStyle}>Status</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key, idx) => (
                <tr key={key.id} style={{ background: idx % 2 === 0 ? 'var(--stone-50)' : 'transparent' }}>
                  <td style={{ ...tdStyle, fontWeight: 500 }}>{key.name}</td>
                  <td style={tdStyle}>
                    <code style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--text-sm)',
                      padding: '2px 6px',
                      background: 'var(--stone-100)',
                      borderRadius: 'var(--radius-sm)',
                      color: 'var(--stone-600)',
                    }}>
                      {key.keyPreview}
                    </code>
                  </td>
                  <td style={{ ...tdStyle, fontSize: 'var(--text-sm)', color: 'var(--stone-500)' }}>
                    {formatDate(key.createdAt)}
                  </td>
                  <td style={{ ...tdStyle, fontSize: 'var(--text-sm)', color: 'var(--stone-500)' }}>
                    {formatDate(key.lastUsedAt)}
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span
                        className={`badge ${key.isActive ? 'badge-success' : 'badge-error'}`}
                      >
                        <span className="badge-dot" />
                        {key.isActive ? 'Active' : 'Revoked'}
                      </span>
                      {key.isActive && (() => {
                        const exp = expirationLabel(key.expiresAt);
                        return exp ? (
                          <span style={{ fontSize: 'var(--text-xs)', color: exp.color, fontWeight: 500 }}>
                            {exp.text}
                          </span>
                        ) : null;
                      })()}
                    </div>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    {key.isActive && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRevokeTarget(key)}
                        style={{ color: 'var(--color-error)' }}
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Generate Key Dialog */}
      <Dialog
        open={showGenerate}
        onClose={() => setShowGenerate(false)}
        title="Generate New API Key"
        description="Create a new key for API access. Choose a descriptive name and expiration."
        size="sm"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <Input
            label="Key Name"
            placeholder="e.g. Production Server"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <Select
            label="Expiration"
            options={EXPIRATION_OPTIONS}
            value={expiration}
            onChange={(e) => setExpiration(e.target.value)}
          />
          {generateError && (
            <div style={{ padding: '10px 14px', background: 'var(--color-error-bg)', color: '#991B1B', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)' }}>
              {generateError}
            </div>
          )}
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '8px' }}>
            <Button variant="secondary" onClick={() => { setShowGenerate(false); setGenerateError(null); }}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={generating}
              disabled={!newName.trim()}
              onClick={generateKey}
            >
              Generate Key
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Revoke Confirmation Dialog */}
      <Dialog
        open={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        title="Revoke API Key"
        description={`Are you sure you want to revoke "${revokeTarget?.name}"? This action cannot be undone. Any applications using this key will lose access immediately.`}
        size="sm"
      >
        {revokeError && (
          <div style={{ padding: '10px 14px', background: 'var(--color-error-bg)', color: '#991B1B', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)', marginBottom: '8px' }}>
            {revokeError}
          </div>
        )}
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '8px' }}>
          <Button variant="secondary" onClick={() => { setRevokeTarget(null); setRevokeError(null); }}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={revoking}
            onClick={() => revokeTarget && revokeKey(revokeTarget.id)}
          >
            Revoke Key
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
