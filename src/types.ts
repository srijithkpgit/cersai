export interface WarningRow {
  rowNumber: number;
  message: string;
  filePath: string;
  lineInCode: number;
  column: number;
  codeLine: string;
  existingPriority?: string;
}

export interface AnalysisResult {
  priority: 'HIGH_PRIO' | 'LOW_PRIO' | 'FALSE_POSITIVE';
  comment: string;
  fixOldCode?: string;
  fixNewCode?: string;
  fixApplied?: boolean;
}

export type DefensivenessLevel = 'relaxed' | 'neutral' | 'strict';

export interface ProjectContext {
  targetPlatform: string;
  compiler: string;
  rtos: string;
  safetyStandard: string;
  projectNotes: string;
}

export interface ColumnMapping {
  message: string;
  path: string;
  lineInCode: string;
  column: string;
  codeLine: string;
}

export type ProgressCallback = (current: number, total: number, message: string) => void;
export type ResultCallback = (rowNumber: number, result: AnalysisResult | null, error?: string) => void;
