import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WarningRow, AnalysisResult, ProgressCallback, ResultCallback, DefensivenessLevel, ProjectContext, ColumnMapping } from './types';
import { readWarnings, writeResult } from './excelService';
import { getCodeContext, findRelatedDefinitions, clearFileCache } from './codeContextService';
import { analyzeWarning, challengeAnalysis } from './aiService';

export interface AnalysisSummary {
  total: number;
  analyzed: number;
  highPrio: number;
  lowPrio: number;
  falsePositive: number;
  fixed: number;
  errors: number;
  cancelled: boolean;
  skipped: number;
  upgraded: number;
}

export async function runAnalysis(
  excelPath: string,
  projectRoot: string,
  defensiveness: DefensivenessLevel,
  projectContext: ProjectContext,
  autoFix: boolean,
  skipAnalyzed: boolean,
  selectedRows: Set<number> | undefined,
  reviewFixes: boolean,
  verifyResults: boolean,
  columnMapping: ColumnMapping | undefined,
  pathFilter: string | undefined,
  analyserName: string | undefined,
  onProgress: ProgressCallback,
  onResult: ResultCallback,
  cancellationToken: vscode.CancellationToken
): Promise<AnalysisSummary> {
  const allWarnings = await readWarnings(excelPath, columnMapping);

  let filtered = allWarnings;
  if (selectedRows && selectedRows.size > 0) {
    filtered = allWarnings.filter(w => selectedRows.has(w.rowNumber));
  }

  // Apply path filter — case-insensitive substring match
  if (pathFilter && pathFilter.length > 0) {
    const filterLower = pathFilter.toLowerCase();
    filtered = filtered.filter(w => w.filePath.toLowerCase().includes(filterLower));
  }

  const skippedCount = skipAnalyzed
    ? filtered.filter(w => w.existingPriority && w.existingPriority.length > 0).length
    : 0;
  const warnings = skipAnalyzed
    ? filtered.filter(w => !w.existingPriority || w.existingPriority.length === 0)
    : filtered;

  const summary: AnalysisSummary = {
    total: warnings.length,
    analyzed: 0,
    highPrio: 0,
    lowPrio: 0,
    falsePositive: 0,
    fixed: 0,
    errors: 0,
    cancelled: false,
    skipped: skippedCount,
    upgraded: 0,
  };

  if (allWarnings.length === 0) {
    throw new Error('No warnings found in the Excel file. Check that the required columns exist: Message, Path, Line-in-Code, Column, Code-Line');
  }

  if (warnings.length === 0 && skippedCount > 0) {
    throw new Error(`All ${skippedCount} warnings already have a Priority value. Uncheck "Skip analyzed" to re-analyze them.`);
  }

  const warningTimes: number[] = [];
  const CONCURRENCY = 3;

  // Write queue to serialize Excel writes
  let writeQueue = Promise.resolve();
  function enqueueWrite(fn: () => Promise<void>): void {
    writeQueue = writeQueue.then(fn).catch((err) => {
      summary.errors++;
      console.error('Excel write error:', err);
    });
  }

  let completedCount = 0;

  async function processWarning(warning: WarningRow, index: number): Promise<void> {
    if (cancellationToken.isCancellationRequested) { return; }

    const warningStartTime = Date.now();

    try {
      // Step 1: Get code context from source file
      const codeContext = await getCodeContext(
        projectRoot,
        warning.filePath,
        warning.lineInCode
      );

      // Step 2: Find related definitions, call chains, callers
      const relatedDefs = await findRelatedDefinitions(
        projectRoot,
        codeContext,
        warning.filePath,
        warning.lineInCode
      );

      // Step 3: AI analysis
      let result = await analyzeWarning(
        warning,
        codeContext,
        relatedDefs,
        defensiveness,
        projectContext,
        cancellationToken
      );

      // Step 3b: Challenger verification for non-HIGH results
      if (verifyResults && result.priority !== 'HIGH_PRIO' && !cancellationToken.isCancellationRequested) {
        const verified = await challengeAnalysis(
          warning,
          codeContext,
          relatedDefs,
          result,
          projectContext,
          cancellationToken
        );
        if (verified.priority === 'HIGH_PRIO') {
          summary.upgraded++;
        }
        result = verified;
      }

      // Step 4: Auto-fix if enabled and HIGH_PRIO with fix data
      // When reviewFixes is on, skip auto-apply — fixes will be reviewed in diff editor
      if (autoFix && !reviewFixes && result.priority === 'HIGH_PRIO' && result.fixOldCode && result.fixNewCode) {
        const fixed = applyCodeFix(projectRoot, warning.filePath, result.fixOldCode, result.fixNewCode);
        result.fixApplied = fixed;
        if (fixed) {
          summary.fixed++;
        }
      }

      // Step 5: Write result to Excel (serialized via queue)
      enqueueWrite(() => writeResult(excelPath, warning.rowNumber, result, columnMapping, analyserName));

      // Update summary
      summary.analyzed++;
      if (result.priority === 'HIGH_PRIO') {
        summary.highPrio++;
      } else if (result.priority === 'FALSE_POSITIVE') {
        summary.falsePositive++;
      } else {
        summary.lowPrio++;
      }

      completedCount++;
      warningTimes.push(Date.now() - warningStartTime);

      // Calculate ETA
      let etaStr = '';
      if (warningTimes.length > 0) {
        const avgTime = warningTimes.reduce((a, b) => a + b, 0) / warningTimes.length;
        const remaining = (warnings.length - completedCount) * avgTime / CONCURRENCY;
        etaStr = ` | ETA: ${formatDuration(remaining)}`;
      }
      onProgress(completedCount, warnings.length, `Analyzed row ${warning.rowNumber}${etaStr}`);
      onResult(warning.rowNumber, result);

    } catch (err) {
      summary.errors++;
      const errorMsg = err instanceof Error ? err.message : String(err);
      completedCount++;
      warningTimes.push(Date.now() - warningStartTime);

      if (cancellationToken.isCancellationRequested) {
        summary.cancelled = true;
        return;
      }

      onProgress(completedCount, warnings.length, `Error on row ${warning.rowNumber}`);
      onResult(warning.rowNumber, null, errorMsg);
    }
  }

  // Concurrency pool
  let nextIndex = 0;
  async function runWorker(): Promise<void> {
    while (nextIndex < warnings.length) {
      if (cancellationToken.isCancellationRequested) {
        summary.cancelled = true;
        return;
      }
      const idx = nextIndex++;
      await processWarning(warnings[idx], idx);
      // Small delay between requests per worker
      if (!cancellationToken.isCancellationRequested) {
        await delay(300);
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, warnings.length) }, () => runWorker());
  await Promise.all(workers);

  // Wait for all queued writes to finish
  await writeQueue;

  // Clear file cache after analysis completes
  clearFileCache();

  return summary;
}

function formatDuration(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) { return `${totalSec}s`; }
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function applyCodeFix(
  projectRoot: string,
  filePath: string,
  oldCode: string,
  newCode: string
): boolean {
  try {
    const fullPath = path.resolve(
      projectRoot,
      path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath)
    );

    // Prevent path traversal — file must be within the project root
    if (!fullPath.startsWith(path.resolve(projectRoot) + path.sep)) {
      return false;
    }

    if (!fs.existsSync(fullPath)) {
      return false;
    }

    const content = fs.readFileSync(fullPath, 'utf-8');

    // Try exact match first
    if (content.includes(oldCode)) {
      const updated = content.replace(oldCode, newCode);
      fs.writeFileSync(fullPath, updated, 'utf-8');
      return true;
    }

    // Try with normalized whitespace (trim each line, then match)
    const normalizeLines = (s: string) => s.split('\n').map(l => l.trim()).join('\n');
    const normalizedOld = normalizeLines(oldCode);
    const contentLines = content.split('\n');

    // Sliding window match over content lines
    const oldLines = normalizedOld.split('\n');
    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      const windowNormalized = contentLines
        .slice(i, i + oldLines.length)
        .map(l => l.trim())
        .join('\n');

      if (windowNormalized === normalizedOld) {
        // Found the match — replace the original lines preserving surrounding content
        const before = contentLines.slice(0, i).join('\n');
        const after = contentLines.slice(i + oldLines.length).join('\n');
        const updated = before + (before ? '\n' : '') + newCode + (after ? '\n' : '') + after;
        fs.writeFileSync(fullPath, updated, 'utf-8');
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}
