import type { Platform } from '@/pipeline/types';
import { plsqlAdapter } from './plsql';
import { shellPythonAdapter } from './shell-python';
import type { PlatformAdapter } from './types';

export const ADAPTERS: Record<Platform, PlatformAdapter> = { plsql: plsqlAdapter, 'shell-python': shellPythonAdapter };
export type { PlatformAdapter } from './types';
