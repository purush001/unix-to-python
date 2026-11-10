import { plsqlAdapter } from '@/adapters/plsql';
import { makeAgent } from './agent';

/** sql-agent: one sanitized SQL, PL/SQL or SQL*Plus unit in, the dual-compatible unit and a change list out (section 9). */
export const sqlAgent = makeAgent(plsqlAdapter);
