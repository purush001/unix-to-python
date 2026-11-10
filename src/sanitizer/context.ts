import type { SanitizeCounts } from '@/pipeline/types';

export type Role = 'source' | 'target';
export type Lang = 'shell' | 'sql' | 'python' | 'ini' | 'text';

export const OPS_EMAIL = 'ops@script.com';
export const HOST_PH = /^(source|target)_server(_\d+)?$/;
export const USER_PH = /^(source|target)_user(_\d+)?$/;
export const NAME_PH = /^dev\d+$/;

/** True when a captured value is a reference or an existing placeholder, not a literal. */
export function isReference(v: string): boolean {
  const s = v.replace(/^["']|["']$/g, '');
  return (
    s === '' ||
    /^[$&`<{%:]/.test(s) ||
    HOST_PH.test(s) ||
    USER_PH.test(s) ||
    NAME_PH.test(s) ||
    /^(CHANGE_ME|changeme|localhost|127\.0\.0\.1|0\.0\.0\.0|\*+|x+|None|null|NULL)$/.test(s) ||
    /_(server|user)(_\d+)?$/.test(s)
  );
}

/**
 * Per-request placeholder mapping. It exists only while sanitize() runs and is
 * never returned, logged or stored (section 8.5).
 */
export class Ctx {
  counts: SanitizeCounts = { emails: 0, names: 0, hosts: 0, users: 0, secrets: 0, personal: 0 };
  private hosts = new Map<string, string>();
  private users = new Map<string, string>();
  private names = new Map<string, string>();
  private seq = { source_server: 0, target_server: 0, source_user: 0, target_user: 0, dev: 0, personal: new Map<string, number>() };
  private personalValues = new Map<string, string>();
  ambiguous = new Set<string>();
  /** Invisible characters removed and encoded e-mail addresses or hosts decoded before the passes ran. */
  obfuscated = 0;

  private next(base: 'source_server' | 'target_server' | 'source_user' | 'target_user'): string {
    const n = ++this.seq[base];
    return n === 1 ? base : `${base}_${n}`;
  }

  host(original: string, role: Role | 'ambiguous'): string {
    const key = original.toLowerCase();
    let hit = this.hosts.get(key);
    if (!hit && !/^\d+(\.\d+){3}$/.test(key)) {
      // a short name and its fully qualified name are the same machine
      const short = key.split('.')[0];
      for (const [k, ph] of this.hosts) {
        if (/^\d+(\.\d+){3}$/.test(k)) continue;
        if (k.split('.')[0] === short && (k.includes('.') !== key.includes('.') || k === key)) hit = ph;
      }
      if (hit) this.hosts.set(key, hit);
    }
    if (hit) return hit;
    const ph = this.next(role === 'source' ? 'source_server' : 'target_server');
    if (role === 'ambiguous') this.ambiguous.add(ph);
    this.hosts.set(key, ph);
    this.counts.hosts++;
    return ph;
  }
  knownHosts(): [string, string][] {
    return [...this.hosts.entries()];
  }

  user(original: string, role: Role): string {
    const key = `${role}:${original}`;
    const hit = this.users.get(key);
    if (hit) return hit;
    const ph = this.next(role === 'source' ? 'source_user' : 'target_user');
    this.users.set(key, ph);
    this.counts.users++;
    return ph;
  }

  /** Registers every spelling of one person under a single placeholder. */
  name(variants: string[]): string {
    const keys = variants.map((v) => v.trim().toLowerCase()).filter((v) => v.length > 1);
    let ph = keys.map((k) => this.names.get(k)).find(Boolean);
    if (!ph) {
      ph = `dev${++this.seq.dev}`;
      this.counts.names++;
    }
    for (const k of keys) if (!this.names.has(k)) this.names.set(k, ph);
    return ph;
  }
  /** Renumbers dev1, dev2, … by where each person first appears in the text. */
  renumberNames(text: string): void {
    const lower = text.toLowerCase();
    const first = new Map<string, number>();
    for (const [variant, ph] of this.names) {
      const at = lower.indexOf(variant);
      if (at === -1) continue;
      first.set(ph, Math.min(first.get(ph) ?? Infinity, at));
    }
    const order = [...new Set(this.names.values())].sort((a, b) => (first.get(a) ?? Infinity) - (first.get(b) ?? Infinity));
    const renamed = new Map(order.map((ph, i) => [ph, `dev${i + 1}`]));
    for (const [variant, ph] of this.names) this.names.set(variant, renamed.get(ph)!);
  }
  knownNames(): [string, string][] {
    return [...this.names.entries()].sort((a, b) => b[0].length - a[0].length);
  }

  personal(kind: string, original: string): string {
    const key = `${kind}:${original}`;
    const hit = this.personalValues.get(key);
    if (hit) return hit;
    const n = (this.seq.personal.get(kind) ?? 0) + 1;
    this.seq.personal.set(kind, n);
    const ph = `${kind}_${n}`;
    this.personalValues.set(key, ph);
    this.counts.personal++;
    return ph;
  }
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
