'use client';

import { useId, useState, type FormEvent } from 'react';

interface Props {
  error: string | null;
  onSubmit: (token: string) => void;
}

/** Asks once for the shared access token. It is kept in sessionStorage only and sent as a Bearer header. */
export function TokenGate({ error, onSubmit }: Props) {
  const id = useId();
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = value.trim();
    if (t) onSubmit(t);
  };
  return (
    <section className="gate panel" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="panel-title">
        Unlock the workbench
      </h2>
      <p className="gate-text">
        This workbench is protected by a shared access token. It is not a provider API key. It stays in this browser tab (session storage) and is sent only to this
        application.
      </p>
      <form className="gate-form" onSubmit={submit}>
        <label htmlFor={`${id}-t`} className="field-label">
          Access token
        </label>
        <div className="gate-row">
          <input
            id={`${id}-t`}
            name="access-token"
            type="password"
            className="input"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-describedby={error ? `${id}-e` : undefined}
            aria-invalid={error ? true : undefined}
            required
          />
          <button type="submit" className="btn btn-primary">
            Unlock
          </button>
        </div>
        {error ? (
          <p id={`${id}-e`} className="msg msg-error" role="alert">
            <span aria-hidden="true">✕ </span>
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}
