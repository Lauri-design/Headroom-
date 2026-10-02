'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';

const OB = {
  green: '#BCD727', greenDark: '#8fa31b', greyDeep: '#373c3c',
  grey: '#999999', greyPale: '#f0f0f0', white: '#ffffff', cancelled: '#c0392b',
};
const FONT = "'Proxima Nova', 'Nunito Sans', Arial, sans-serif";

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError(error.message);
    } else {
      router.push('/');
      router.refresh();
    }
  }

  const inputStyle = {
    width: '100%', fontSize: 13, padding: '9px 12px', borderRadius: 3,
    border: `1px solid ${OB.greyPale}`, background: OB.white,
    color: OB.greyDeep, boxSizing: 'border-box', outline: 'none', fontFamily: FONT,
  };
  const labelStyle = {
    display: 'block', fontSize: 11, fontWeight: 600, color: OB.grey,
    textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6, fontFamily: FONT,
  };

  return (
    <div style={{ minHeight: '100vh', background: OB.greyPale, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT }}>
      <div style={{ width: '100%', maxWidth: 400, padding: '0 16px' }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 0, marginBottom: '1.25rem' }}>
            <span style={{ fontSize: 22, fontWeight: 700, color: OB.greyDeep, background: OB.green, padding: '6px 0 6px 14px', borderRadius: '6px 0 0 6px', letterSpacing: '-0.03em' }}>open</span>
            <span style={{ fontSize: 22, fontWeight: 700, color: OB.white, background: OB.grey, padding: '6px 14px 6px 0', borderRadius: '0 6px 6px 0', letterSpacing: '-0.03em' }}>box</span>
          </div>
          <div style={{ fontSize: 20, fontWeight: 300, color: OB.greyDeep, letterSpacing: '-0.02em' }}>Headroom</div>
          <div style={{ fontSize: 13, color: OB.grey, marginTop: 4 }}>Resource capacity planning by Open Box</div>
        </div>

        <div style={{ background: OB.white, borderRadius: 6, borderTop: `3px solid ${OB.green}`, padding: '2rem', boxShadow: '0 2px 12px rgba(0,0,0,0.06)' }}>
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: '1rem' }}>
              <label style={labelStyle}>Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@openboxsoftware.com" autoComplete="email" style={inputStyle} />
            </div>
            <div style={{ marginBottom: '1.5rem' }}>
              <label style={labelStyle}>Password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" style={inputStyle} />
            </div>
            {error && (
              <div style={{ fontSize: 12, color: OB.cancelled, background: '#fdf0ef', borderRadius: 3, padding: '8px 12px', marginBottom: '1rem', borderLeft: `3px solid ${OB.cancelled}` }}>
                {error}
              </div>
            )}
            <button type="submit" disabled={loading} style={{ width: '100%', padding: 10, borderRadius: 3, border: 'none', background: OB.green, color: OB.greyDeep, fontSize: 13, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1, fontFamily: FONT }}>
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          <div style={{ marginTop: '1.25rem', paddingTop: '1.25rem', borderTop: `1px solid ${OB.greyPale}`, textAlign: 'center', fontSize: 11, color: OB.grey }}>
            Forgot your password? Contact your administrator.
          </div>
        </div>
        <div style={{ textAlign: 'center', marginTop: '1.5rem', fontSize: 11, color: OB.grey }}>
          There&apos;s always a better way
        </div>
      </div>
    </div>
  );
}
