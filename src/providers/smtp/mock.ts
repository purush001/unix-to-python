import type { MailMessage, SmtpProvider } from '../types';

export function mockOutbox(): MailMessage[] {
  const g = globalThis as unknown as { __mockOutbox?: MailMessage[] };
  return (g.__mockOutbox ??= []);
}
export function createMockSmtp(): SmtpProvider {
  return {
    name: 'mock',
    async send(msg) {
      mockOutbox().push(msg);
    },
  };
}
