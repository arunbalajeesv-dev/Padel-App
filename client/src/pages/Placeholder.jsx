/**
 * Placeholder for a tab that has no screen yet.
 *
 * Deliberately inert: no API calls, no fake data. A placeholder that renders
 * plausible-looking match cards is worse than an empty one, because it hides
 * which screens are actually built.
 */
export default function Placeholder({ title, note }) {
  return (
    <section className="page">
      <h1 className="page-title">{title}</h1>
      <p className="page-note">{note}</p>
      <p className="page-stub">Not built yet.</p>
    </section>
  );
}
