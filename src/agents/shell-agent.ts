import { shellPythonAdapter } from '@/adapters/shell-python';
import { makeAgent } from './agent';

/** shell-agent: one sanitized shell unit (embedded SQL already converted) in, one Python script out (sections 10 and 11). */
export const shellAgent = makeAgent(shellPythonAdapter);
