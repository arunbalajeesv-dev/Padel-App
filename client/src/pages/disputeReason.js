/**
 * Pure helpers for composing a dispute reason.
 *
 * The backend has ONE `reason` field (min 10 chars) and no separate detail
 * field, so the selected category and the free-text detail are combined into a
 * single human-readable string an admin can read at a glance. See
 * disputesService.validateCreate.
 */

/** The radio options. `value` is what shows and what seeds the reason string. */
export const DISPUTE_REASONS = [
  "I didn't play this match",
  'Wrong score',
  'Wrong players',
  'Wrong court',
  'Other',
];

export const OTHER = 'Other';

const MIN_REASON = 10; // mirrors the backend

/**
 * Compose the `reason` string sent to the API from the selected category and
 * optional detail. "Category — detail" when detail is present, else the category
 * alone.
 */
export function composeReason(selected, detail) {
  const d = (detail ?? '').trim();
  if (!selected) return '';
  return d ? `${selected} — ${d}` : selected;
}

/**
 * Whether the form may be submitted, and why not.
 *
 * "Other" REQUIRES detail (the category alone says nothing). Every other
 * category is self-sufficient. The composed reason must also clear the backend's
 * 10-char minimum, which the non-Other categories do on their own.
 *
 * @returns {{ok: boolean, message: string|null}}
 */
export function validateDispute(selected, detail) {
  if (!selected) return { ok: false, message: 'Choose what went wrong.' };

  const d = (detail ?? '').trim();
  if (selected === OTHER && d.length === 0) {
    return { ok: false, message: 'Tell us what happened.' };
  }

  if (composeReason(selected, detail).length < MIN_REASON) {
    return { ok: false, message: 'Please add a little more detail.' };
  }

  return { ok: true, message: null };
}
