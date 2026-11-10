import type { SanitizeCounts } from '@/pipeline/types';

/** Count summary shown to the user. The mapping itself is never shown. */
export function countSummary(c: SanitizeCounts): string {
  const part = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : '');
  const parts = [part(c.emails, 'email', 'emails'), part(c.names, 'name', 'names'), part(c.hosts, 'host', 'hosts'), part(c.users, 'user', 'users'), part(c.secrets, 'password', 'passwords'), part(c.personal, 'personal value', 'personal values')].filter(Boolean);
  return parts.length ? `${parts.join(', ')} replaced` : 'Nothing needed replacing';
}
