import { Hook } from '@/components/Hook';
import { Modernizer } from '@/components/Modernizer';

export default function Page() {
  return (
    <div className="page">
      <a className="skip-link" href="#main">
        Skip to the workbench
      </a>
      <header className="hero">
        <div className="hero-inner">
          <p className="brand">
            <span className="brand-mark" aria-hidden="true">
              ◆
            </span>
            Script Modernizer
          </p>
          <Hook>
            <h1 className="headline">19c and shell in. Upgrade-safe SQL and Python out.</h1>
            <p className="subhead">The SQL and PL/SQL it writes run unchanged on both Oracle 19c and 26ai.</p>
          </Hook>
        </div>
      </header>
      <Modernizer />
      <footer className="foot">
        <p>Scripts are sanitized before conversion. Drafts are saved to GitHub only after you approve them.</p>
      </footer>
    </div>
  );
}
