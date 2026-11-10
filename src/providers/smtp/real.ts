import nodemailer from 'nodemailer';
import { getConfig, getConfigInt, getSecret } from '@/config/env';
import type { SmtpProvider } from '../types';

export function createRealSmtp(): SmtpProvider {
  return {
    name: 'smtp',
    async send(msg) {
      const user = getSecret('SMTP_USER');
      const pass = getSecret('SMTP_PASSWORD');
      const port = getConfigInt('SMTP_PORT');
      const transport = nodemailer.createTransport({
        host: getConfig('SMTP_HOST'),
        port,
        secure: port === 465,
        auth: user && pass ? { user, pass } : undefined,
        connectionTimeout: 10000,
      });
      try {
        await transport.sendMail({ from: getConfig('SMTP_FROM'), to: msg.to, subject: msg.subject, text: msg.text });
      } finally {
        transport.close();
      }
    },
  };
}
