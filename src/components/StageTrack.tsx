import type { StageName } from '@/pipeline/types';

export type StageStatus = 'pending' | 'active' | 'done' | 'skipped';
export type StageMap = Record<StageName, StageStatus>;

export const STAGES: StageName[] = ['intake', 'generate', 'validate', 'repair', 'review', 'results'];

export const emptyStages = (): StageMap => ({ intake: 'pending', generate: 'pending', validate: 'pending', repair: 'pending', review: 'pending', results: 'pending' });

const HINT: Record<StageName, string> = {
  intake: 'sanitize + detect',
  generate: 'write the draft',
  validate: 'parse + rules',
  repair: 'fix errors',
  review: 'independent check',
  results: 'assemble',
};
const WORD: Record<StageStatus, string> = { pending: 'waiting', active: 'running', done: 'done', skipped: 'skipped' };
const GLYPH: Record<StageStatus, string> = { pending: '○', active: '◐', done: '✓', skipped: '–' };

interface Props {
  stages: StageMap;
  unit: string | null;
  announcement: string;
}

export function StageTrack({ stages, unit, announcement }: Props) {
  return (
    <div className="track-wrap">
      <ol className="track" aria-label="Pipeline stages" data-testid="stage-track">
        {STAGES.map((s, i) => (
          <li key={s} className={`station station-${stages[s]}`} data-stage={s} data-status={stages[s]}>
            <span className="station-mark" aria-hidden="true">
              <span className="station-glyph">{GLYPH[stages[s]]}</span>
            </span>
            <span className="station-text">
              <span className="station-name">
                <span className="station-no" aria-hidden="true">
                  {i + 1}
                </span>
                {s}
              </span>
              <span className="station-state">
                {WORD[stages[s]]}
                {stages[s] === 'active' && unit ? ` · ${unit}` : ''}
              </span>
              <span className="station-hint">{HINT[s]}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="sr-only" aria-live="polite" role="status" data-testid="stage-live">
        {announcement}
      </p>
    </div>
  );
}
