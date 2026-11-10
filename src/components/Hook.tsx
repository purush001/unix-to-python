'use client';

import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { session } from './api';

const FLAG = 'sm.hookSeen';
const DURATION_MS = 5800;

/** Each row: the legacy line and the line it becomes. All values are invented. */
const ROWS: { old: string; now: string }[] = [
  { old: 'sqlplus -s scott/tiger@ORCL <<EOF', now: 'conn = oracledb.connect(**cfg["database"])' },
  { old: 'FOR r IN (SELECT empno FROM emp) LOOP', now: 'cur.executemany(UPDATE_EMP, rows)' },
  { old: '  UPDATE emp SET sal = sal * 1.05 …; COMMIT;', now: 'conn.commit()' },
  { old: 'END LOOP;', now: 'log.info("updated %d rows", cur.rowcount)' },
];

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * The six-second hook. Pure CSS: the server renders the "playing" markup, the animation
 * ends on the final state by itself, and this component only skips it (button, Escape,
 * already seen in this session). The page below stays usable the whole time.
 */
export function Hook({ children }: { children: React.ReactNode }) {
  const [done, setDone] = useState(false);

  const finish = useCallback(() => {
    setDone(true);
    session.setFlag(FLAG);
  }, []);

  useIsoLayoutEffect(() => {
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (session.flag(FLAG) || reduced) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- must run before first paint to avoid replaying the animation
      setDone(true);
      session.setFlag(FLAG);
      return;
    }
    const timer = window.setTimeout(finish, DURATION_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [finish]);

  return (
    <div className={`hook ${done ? 'hook-done' : 'hook-playing'}`} data-testid="hook" data-state={done ? 'done' : 'playing'}>
      <div className="hook-copy">{children}</div>
      <div className="hook-stage">
        <div className="tape" aria-hidden="true">
          <div className="tape-head">
            <span className="tape-tag tape-tag-old">19c · ksh + sqlplus</span>
            <span className="tape-tag tape-tag-new">19c + 26ai · Python</span>
          </div>
          <div className="tape-body">
            {ROWS.map((r, i) => (
              <div className={`tape-row tape-row-${i + 1}`} key={r.old}>
                <span className="tape-old">
                  {i === 0 ? (
                    <>
                      sqlplus -s scott/<span className="tape-secret">tiger</span>@ORCL &lt;&lt;EOF
                    </>
                  ) : (
                    r.old
                  )}
                </span>
                <span className="tape-new">{r.now}</span>
              </div>
            ))}
          </div>
        </div>
        <p className="sr-only">Illustration: a sqlplus call with a password and a cursor loop becomes a short Python script that reads its connection from a config file.</p>
        {done ? null : (
          <button type="button" className="btn btn-small hook-skip" onClick={finish}>
            Skip<span className="sr-only"> intro animation</span>
          </button>
        )}
      </div>
    </div>
  );
}
