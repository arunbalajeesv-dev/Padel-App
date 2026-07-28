import { useEffect, useRef, useState } from 'react';
import { RecaptchaVerifier, signInWithPhoneNumber } from 'firebase/auth';

import { auth } from './firebase.js';
import { describeAuthError } from './authErrors.js';
import logo from '../assets/logo.png';

/**
 * Phone OTP sign-in: number → SMS code → verified.
 *
 * On success we do nothing but let Firebase fire `onAuthStateChanged`.
 * AuthContext picks it up, calls getMe, and the router decides where to go —
 * profile setup or Home. This component deliberately does not route, so there is
 * one place that decides what an authenticated user sees.
 *
 * ---------------------------------------------------------------------------
 * THE reCAPTCHA VERIFIER IS SINGLE-USE.
 *
 * Firebase requires a verifier for phone auth and will reject a stale one. It is
 * created on demand and torn down after any failure, so a retry always gets a
 * fresh one. Reusing it produces `auth/captcha-check-failed` on the second
 * attempt — an error that looks like a bad phone number and is not.
 * ---------------------------------------------------------------------------
 */

const STEP = { PHONE: 'phone', OTP: 'otp' };
const RECAPTCHA_CONTAINER_ID = 'recaptcha-container';

export default function SignIn() {
  const [step, setStep] = useState(STEP.PHONE);
  const [phone, setPhone] = useState('+91');
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const verifierRef = useRef(null);
  const confirmationRef = useRef(null);

  const clearVerifier = () => {
    try {
      verifierRef.current?.clear();
    } catch {
      // Already torn down — nothing to do.
    }
    verifierRef.current = null;
  };

  useEffect(() => clearVerifier, []);

  function getVerifier() {
    if (!verifierRef.current) {
      verifierRef.current = new RecaptchaVerifier(auth(), RECAPTCHA_CONTAINER_ID, {
        size: 'invisible',
      });
    }
    return verifierRef.current;
  }

  async function sendCode(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      confirmationRef.current = await signInWithPhoneNumber(auth(), phone.trim(), getVerifier());
      setStep(STEP.OTP);
    } catch (err) {
      const described = describeAuthError(err);
      setError(described);
      // A failed send always invalidates the verifier.
      clearVerifier();
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await confirmationRef.current.confirm(code.trim());
      // Success: AuthContext takes over from here.
    } catch (err) {
      const described = describeAuthError(err);
      setError(described);
      if (described.needsRestart) {
        // The code or the attempt is dead — retyping cannot help, so send the
        // player back to the start rather than letting them poke at a field
        // that will never accept anything.
        clearVerifier();
        confirmationRef.current = null;
        setCode('');
        setStep(STEP.PHONE);
      }
    } finally {
      setBusy(false);
    }
  }

  function restart() {
    clearVerifier();
    confirmationRef.current = null;
    setCode('');
    setError(null);
    setStep(STEP.PHONE);
  }

  return (
    <section className="page auth-page">
      <img className="auth-logo" src={logo} alt="Padel Chennai Community" />

      <h1 className="page-title">
        {step === STEP.PHONE ? 'Sign in' : 'Enter the code'}
      </h1>

      {step === STEP.PHONE ? (
        <form onSubmit={sendCode} className="auth-form">
          <p className="page-note">We'll text you a 6-digit code.</p>
          <label className="field-label" htmlFor="phone">
            Phone number
          </label>
          <input
            id="phone"
            className="field"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+91 98765 43210"
            required
          />
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </form>
      ) : (
        <form onSubmit={verifyCode} className="auth-form">
          <p className="page-note">Sent to {phone}.</p>
          <label className="field-label" htmlFor="code">
            6-digit code
          </label>
          <input
            id="code"
            className="field"
            type="text"
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            placeholder="123456"
            required
          />
          <button className="btn-primary" type="submit" disabled={busy || code.length < 6}>
            {busy ? 'Verifying…' : 'Verify'}
          </button>
          <button className="btn-link" type="button" onClick={restart} disabled={busy}>
            Use a different number
          </button>
        </form>
      )}

      {error && (
        <p className="field-error" role="alert">
          {error.message}
        </p>
      )}

      {/* Invisible reCAPTCHA mounts here. Must exist before the verifier is built. */}
      <div id={RECAPTCHA_CONTAINER_ID} />
    </section>
  );
}
