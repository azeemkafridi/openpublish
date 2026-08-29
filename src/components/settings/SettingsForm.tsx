import { useState, useEffect, useCallback, type CSSProperties } from 'react';
import { Spinner } from '../ui/Spinner';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

// Keys MUST match the API/Drizzle field names (camelCase). The server returns
// and accepts camelCase (e.g. `emailOnFailure`); using snake_case here silently
// broke both reading prefs (toggles always showed off) and saving them (the PUT
// body was ignored), so a user could never actually disable an email category.
interface NotificationPreferences {
  emailOnFailure: boolean;
  emailOnTokenExpiry: boolean;
  inAppPublished: boolean;
  inAppFailed: boolean;
  inAppScheduleReminder: boolean;
  inAppTokenExpiry: boolean;
}

export const NOTIFICATION_TOGGLES: Array<{
  key: keyof NotificationPreferences;
  label: string;
  description: string;
}> = [
  {
    key: 'emailOnFailure',
    label: 'Email on post failure',
    description: 'Receive an email whenever a post fails to publish to any channel.',
  },
  {
    key: 'emailOnTokenExpiry',
    label: 'Email on token expiry',
    description: 'Receive an email when a connected channel token is about to expire or fails to refresh.',
  },
  {
    key: 'inAppPublished',
    label: 'In-app: post published',
    description: 'Show an in-app notification when a post is successfully published.',
  },
  {
    key: 'inAppFailed',
    label: 'In-app: post failed',
    description: 'Show an in-app notification when a post fails to publish.',
  },
  {
    key: 'inAppScheduleReminder',
    label: 'In-app: schedule reminders',
    description: 'Get a reminder before a scheduled post is about to be published.',
  },
  {
    key: 'inAppTokenExpiry',
    label: 'In-app: token expiry warnings',
    description: 'Get notified when a connected channel token is about to expire and needs re-authentication.',
  },
];

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const trackStyle: CSSProperties = {
    width: '44px',
    height: '24px',
    borderRadius: 'var(--radius-pill)',
    background: checked ? 'var(--accent-500)' : '#D6D3D1',
    position: 'relative',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'background var(--transition-base)',
    flexShrink: 0,
    opacity: disabled ? 0.5 : 1,
  };

  const thumbStyle: CSSProperties = {
    width: '20px',
    height: '20px',
    borderRadius: '50%',
    background: '#FFFFFF',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    position: 'absolute',
    top: '2px',
    left: checked ? '22px' : '2px',
    transition: 'left var(--transition-base)',
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      style={trackStyle}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span style={thumbStyle} />
    </button>
  );
}

/* ─── Change Password Section ─────────────────────── */

function ChangePasswordSection({
  showToast,
  setError,
}: {
  showToast: (msg: string) => void;
  setError: (msg: string | null) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState('');

  const handleChangePassword = async () => {
    setFieldError('');
    setError(null);

    if (!currentPassword) {
      setFieldError('Current password is required');
      return;
    }
    if (newPassword.length < 8) {
      setFieldError('New password must be at least 8 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      setFieldError('Passwords do not match');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword,
          newPassword,
          revokeOtherSessions: false,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.message || data?.error?.message || 'Failed to change password');
      }

      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      showToast('Password changed successfully');
    } catch (err: any) {
      setFieldError(err.message || 'Failed to change password');
    } finally {
      setSaving(false);
    }
  };

  const sectionHeaderStyle: CSSProperties = {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-lg)',
    color: 'var(--stone-900)',
    marginBottom: '4px',
  };

  const sectionDescStyle: CSSProperties = {
    fontSize: 'var(--text-sm)',
    color: 'var(--stone-500)',
    lineHeight: 'var(--leading-relaxed)',
    marginBottom: '20px',
  };

  const passwordInputStyle: CSSProperties = {
    background: 'var(--stone-100)',
  };

  return (
    <div style={{ marginBottom: '36px' }}>
      <h3 style={sectionHeaderStyle}>Change Password</h3>
      <p style={sectionDescStyle}>
        Update your account password. You'll need your current password to make changes.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '400px', marginBottom: '16px' }}>
        <Input
          label="Current Password"
          type="password"
          placeholder="Enter current password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
          style={passwordInputStyle}
        />
        <Input
          label="New Password"
          type="password"
          placeholder="Enter new password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          hint="Minimum 8 characters"
          autoComplete="new-password"
          style={passwordInputStyle}
        />
        <Input
          label="Confirm New Password"
          type="password"
          placeholder="Confirm new password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
          style={passwordInputStyle}
        />
      </div>

      {fieldError && (
        <div style={{
          padding: '10px 14px',
          background: 'var(--color-error-bg)',
          color: '#991B1B',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--text-sm)',
          marginBottom: '14px',
          maxWidth: '400px',
        }}>
          {fieldError}
        </div>
      )}

      <Button
        variant="primary"
        size="md"
        loading={saving}
        onClick={handleChangePassword}
      >
        Change Password
      </Button>
    </div>
  );
}

export default function SettingsForm() {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const fetchPrefs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/notifications/preferences');
      if (!res.ok) throw new Error('Failed to load notification preferences');
      const data = await res.json();
      setPrefs(data);
    } catch (err: any) {
      setError(err.message ?? 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPrefs();
  }, [fetchPrefs]);

  async function saveNotificationPrefs() {
    if (!prefs) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/notifications/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs),
      });
      if (!res.ok) throw new Error('Failed to save preferences');
      showToast('Notification preferences saved');
    } catch (err: any) {
      setError(err.message ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  function updatePref(key: keyof NotificationPreferences, value: boolean) {
    if (!prefs) return;
    setPrefs({ ...prefs, [key]: value });
  }

  // -- Styles --

  const sectionStyle: CSSProperties = {
    marginBottom: '36px',
  };

  const sectionHeaderStyle: CSSProperties = {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-lg)',
    color: 'var(--stone-900)',
    marginBottom: '4px',
  };

  const sectionDescStyle: CSSProperties = {
    fontSize: 'var(--text-sm)',
    color: 'var(--stone-500)',
    lineHeight: 'var(--leading-relaxed)',
    marginBottom: '20px',
  };

  const toggleRowStyle = (index: number): CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '16px',
    padding: '12px 16px',
    borderRadius: '12px',
    background: index % 2 === 0 ? 'var(--stone-50)' : 'transparent',
  });

  const toggleInfoStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
  };

  const toggleLabelStyle: CSSProperties = {
    fontSize: 'var(--text-base)',
    fontWeight: 500,
    color: 'var(--stone-800)',
    marginBottom: '2px',
  };

  const toggleDescStyle: CSSProperties = {
    fontSize: 'var(--text-xs)',
    color: 'var(--stone-400)',
    lineHeight: 'var(--leading-relaxed)',
  };

  const toastStyle: CSSProperties = {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    background: 'var(--stone-900)',
    color: '#FFFFFF',
    padding: '12px 20px',
    borderRadius: 'var(--radius-lg)',
    fontSize: 'var(--text-sm)',
    fontWeight: 500,
    boxShadow: 'var(--shadow-xl)',
    zIndex: 'var(--z-toast)' as any,
    animation: 'fadeInUp 300ms cubic-bezier(0.4, 0, 0.2, 1) both',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div style={{ animation: 'fadeInUp 500ms cubic-bezier(0.4, 0, 0.2, 1) both' }}>
      {/* Error banner */}
      {error && (
        <div style={{
          padding: '12px 16px',
          background: 'var(--color-error-bg)',
          color: '#991B1B',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--text-sm)',
          marginBottom: '20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            style={{ color: '#991B1B', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--text-xs)' }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Change Password Section */}
      <ChangePasswordSection
        showToast={showToast}
        setError={setError}
      />

      {/* Notification Preferences Section */}
      <div style={sectionStyle}>
        <h3 style={sectionHeaderStyle}>Notification Preferences</h3>
        <p style={sectionDescStyle}>
          Choose how you want to be notified about your publishing activity.
        </p>

        <div style={{ marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {prefs && NOTIFICATION_TOGGLES.map((toggle, i) => (
            <div key={toggle.key} style={toggleRowStyle(i)}>
              <div style={toggleInfoStyle}>
                <div style={toggleLabelStyle}>{toggle.label}</div>
                <div style={toggleDescStyle}>{toggle.description}</div>
              </div>
              <Toggle
                checked={prefs[toggle.key]}
                onChange={(v) => updatePref(toggle.key, v)}
                disabled={saving}
              />
            </div>
          ))}
        </div>

        <Button
          variant="primary"
          size="md"
          loading={saving}
          onClick={saveNotificationPrefs}
        >
          Save Notifications
        </Button>
      </div>

      {/* Toast */}
      {toast && (
        <div style={toastStyle}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#10B981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
          </svg>
          {toast}
        </div>
      )}
    </div>
  );
}
