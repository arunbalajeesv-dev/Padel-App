import { useEffect, useRef, useState } from 'react';
import { RecaptchaVerifier, signInWithPhoneNumber } from 'firebase/auth';

import { auth } from './firebase.js';
import { describeAuthError } from './authErrors.js';
import { getSignupGate, checkInviteCode, ApiError } from '../api/index.js';
import { rememberInviteCode, forgetInviteCode } from './inviteCode.js';
import logo from '../assets/logo.png';

/**
 * Phone OTP sign-in: [who are you] → [invite code] → number → SMS code.
 *
 * On success we do nothing but let Firebase fire `onAuthStateChanged`.
 * AuthContext picks it up, calls getMe, and the router decides where to go —
 * profile setup or Home. This component deliberately does not route, so there is
 * one place that decides what an authenticated user sees.
 *
 * ---------------------------------------------------------------------------
 * WHY THE "NEW OR RETURNING" QUESTION COMES FIRST.
 *
 * During a soft launch, joining needs an invite code, and asking for it BEFORE
 * the SMS is the point — otherwise a stranger burns a text and a Firebase Auth
 * account only to be refused at profile creation.
 *
 * But this screen serves returning members too, and nothing here can tell the
 * two apart: whether a phone number already has a profile is only knowable
 * AFTER the token exists. Prompting everyone for a code would lock out every
 * existing member signing in on a new phone.
 *
 * So we ask. It is not a security question and does not need to be — someone
 * who picks "I already have an account" without one simply reaches profile
 * setup, where POST /users re-checks the code against a verified token and
 * refuses. The split exists to spare returning members a prompt that is not
 * for them.
 * ---------------------------------------------------------------------------
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

const STEP = { CHOICE: 'choice', INVITE: 'invite', PHONE: 'phone', OTP: 'otp' };
const RECAPTCHA_CONTAINER_ID = 'recaptcha-container';

export default function SignIn() {
  // Start on the phone step and move back to the choice only if the gate is
  // on. With no soft launch running there is nothing to ask, so returning and
  // new players alike go straight to entering a number, exactly as before.
  const [step, setStep] = useState(STEP.PHONE);
  const [phone, setPhone] = useState('+91');
  const [code, setCode] = useState('');
  const [invite, setInvite] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { inviteRequired } = await getSignupGate();
        // Only reroute if the player has not already started typing — a slow
        // response must never yank someone off a step they are mid-way through.
        if (alive && inviteRequired) {
          setStep((current) => (current === STEP.PHONE ? STEP.CHOICE : current));
        }
      } catch {
        // Gate unknown (offline, or the API is waking up). Fall through to the
        // ordinary phone step: the server still enforces the code at profile
        // creation, so the worst case is the old behaviour, not a bypass.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

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

  /** Validate the invite code before any SMS is sent. */
  async function submitInvite(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await checkInviteCode(invite.trim());
      // Held for POST /users, which re-checks it against a verified token.
      rememberInviteCode(invite.trim());
      setStep(STEP.PHONE);
    } catch (err) {
      const offline = err instanceof ApiError && err.status === 0;
      setError({
        message: offline
          ? "Can't reach the server. Check your connection and try again."
          : err instanceof ApiError && err.status === 429
            ? err.reason ?? 'Too many tries. Wait a few minutes and try again.'
            : 'That invite code is not valid. Check with whoever invited you.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page auth-page">
      <img className="auth-logo" src={logo} alt="Padel Chennai Community" />

      <h1 className="page-title">
        {step === STEP.CHOICE
          ? 'Welcome'
          : step === STEP.INVITE
            ? 'Invite code'
            : step === STEP.PHONE
              ? 'Sign in'
              : 'Enter the code'}
      </h1>

      {step === STEP.CHOICE && (
        <div className="auth-form">
          <p className="page-note">
            We&apos;re still rolling out to the community, so joining needs an
            invite code. Already have an account? You won&apos;t need one.
          </p>
          <button
            className="btn-primary"
            type="button"
            onClick={() => {
              setError(null);
              setStep(STEP.INVITE);
            }}
          >
            I&apos;m new — I have an invite code
          </button>
          <button
            className="btn-link"
            type="button"
            onClick={() => {
              setError(null);
              // A returning member brings no code; make sure a stale one from
              // an abandoned join attempt is not sent on their behalf.
              forgetInviteCode();
              setStep(STEP.PHONE);
            }}
          >
            I already have an account
          </button>
        </div>
      )}

      {step === STEP.INVITE && (
        <form onSubmit={submitInvite} className="auth-form">
          <p className="page-note">
            Ask whoever invited you if you don&apos;t have one.
          </p>
          <label className="field-label" htmlFor="invite">
            Invite code
          </label>
          <input
            id="invite"
            className="field"
            type="text"
            autoCapitalize="characters"
            autoComplete="off"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            placeholder="PADEL-BETA"
            required
          />
          <button className="btn-primary" type="submit" disabled={busy || !invite.trim()}>
            {busy ? 'Checking…' : 'Continue'}
          </button>
          <button
            className="btn-link"
            type="button"
            onClick={() => {
              setError(null);
              setStep(STEP.CHOICE);
            }}
            disabled={busy}
          >
            Back
          </button>
        </form>
      )}

      {step === STEP.PHONE && (
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
      )}

      {step === STEP.OTP && (
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
