import * as vscode from 'vscode';
import * as path from 'path';

let diagnosticCollection: vscode.DiagnosticCollection | undefined;

export function initDiagnostics(): vscode.DiagnosticCollection {
  if (!diagnosticCollection) {
    diagnosticCollection = vscode.languages.createDiagnosticCollection('cersai');
  }
  return diagnosticCollection;
}

export function clearDiagnostics(): void {
  diagnosticCollection?.clear();
}

export function addDiagnostic(
  projectRoot: string,
  filePath: string,
  line: number,
  priority: string,
  comment: string,
  warningMessage: string
): void {
  if (!diagnosticCollection) { return; }

  const fullPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(projectRoot, filePath);
  const uri = vscode.Uri.file(fullPath);
  const lineNum = Math.max(0, (line || 1) - 1);

  const severity = priority === 'HIGH_PRIO'
    ? vscode.DiagnosticSeverity.Error
    : priority === 'LOW_PRIO'
    ? vscode.DiagnosticSeverity.Warning
    : vscode.DiagnosticSeverity.Information;

  // First line of the AI comment as the diagnostic message
  const firstLine = comment.split('\n')[0].substring(0, 200);
  const label = priority === 'FALSE_POSITIVE' ? 'FP' : priority === 'HIGH_PRIO' ? 'HIGH' : 'LOW';

  const range = new vscode.Range(lineNum, 0, lineNum, Number.MAX_SAFE_INTEGER);
  const diagnostic = new vscode.Diagnostic(
    range,
    `[Cersai ${label}] ${warningMessage}\n${firstLine}`,
    severity
  );
  diagnostic.source = 'Cersai';

  // Append to existing diagnostics for this file
  const existing = diagnosticCollection.get(uri) ?? [];
  diagnosticCollection.set(uri, [...existing, diagnostic]);
}

export function disposeDiagnostics(): void {
  diagnosticCollection?.dispose();
  diagnosticCollection = undefined;
}
