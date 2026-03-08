import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { runAnalysis, AnalysisSummary } from './analyzerService';
import { resetModelCache, checkAiAvailability, estimateTokens } from './aiService';
import { readWarnings, readHeaders } from './excelService';
import { WarningRow, ProjectContext, ColumnMapping } from './types';
import { generateHtmlReport } from './reportService';
import { addDiagnostic, clearDiagnostics } from './diagnosticsService';
import { loadConfig, saveConfig, ProjectConfig } from './configService';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _cancellationTokenSource?: vscode.CancellationTokenSource;
  private _isRunning = false;
  private _lastSummary?: AnalysisSummary;
  private _lastResults: { rowNumber: number; priority: string; comment: string; filePath: string; lineInCode: number; fixApplied: boolean }[] = [];
  private _lastExcelPath = '';
  private _lastProjectFolder = '';
  private _pendingFixes: { filePath: string; lineInCode: number; oldCode: string; newCode: string; warningMsg: string; rowNumber: number }[] = [];

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _statusBarItem?: vscode.StatusBarItem
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
    };

    webviewView.webview.html = this._getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'selectExcel':
          await this._selectExcelFile();
          break;
        case 'selectFolder':
          await this._selectProjectFolder();
          break;
        case 'startAnalysis': {
          const ctx: ProjectContext = {
            targetPlatform: message.targetPlatform || '',
            compiler: message.compiler || '',
            rtos: message.rtos || '',
            safetyStandard: message.safetyStandard || '',
            projectNotes: message.projectNotes || '',
          };
          const colMapping: ColumnMapping | undefined = (message.columnMapping?.message && message.columnMapping?.path)
            ? message.columnMapping as ColumnMapping
            : undefined;
          if (message.manualSelect) {
            await this._startWithManualSelection(message.excelPath, message.projectFolder, message.defensiveness, ctx, message.autoFix, message.skipAnalyzed, message.reviewFixes, colMapping);
          } else {
            await this._startAnalysis(message.excelPath, message.projectFolder, message.defensiveness, ctx, message.autoFix, message.skipAnalyzed, undefined, message.reviewFixes, colMapping);
          }
          break;
        }
        case 'cancelAnalysis':
          this._cancelAnalysis();
          break;
        case 'openFile':
          this._openFileAtLine(message.filePath, message.line);
          break;
        case 'exportReport':
          this._exportReport();
          break;
        case 'saveConfig':
          this._saveConfig(message.config);
          break;
        case 'loadConfig':
          this._loadAndSendConfig();
          break;
      }
    });

    // Load config and run initial status check when sidebar loads
    this._runInitialStatusCheck().catch(() => {});
    this._loadAndSendConfig();
  }

  private async _runInitialStatusCheck(): Promise<void> {
    // Small delay to let the webview finish loading
    await new Promise(resolve => setTimeout(resolve, 500));

    const issues: string[] = [];

    // Check Copilot extension
    const copilotExt = vscode.extensions.getExtension('GitHub.copilot');
    if (!copilotExt) {
      issues.push('GitHub Copilot extension is not installed. Install it from the Extensions panel.');
    }

    // Check if any language models are available (with timeout)
    if (copilotExt) {
      try {
        const modelsPromise = vscode.lm.selectChatModels({ vendor: 'copilot' });
        const timeoutPromise = new Promise<null>(resolve => setTimeout(() => resolve(null), 5000));
        const models = await Promise.race([modelsPromise, timeoutPromise]);

        if (models === null) {
          issues.push('Could not reach AI model. Please sign into GitHub (click the person icon in the bottom-left).');
        } else if (!models || models.length === 0) {
          issues.push('Not signed into GitHub Copilot. Click the person icon in the bottom-left to sign in.');
        }
      } catch {
        issues.push('Could not verify AI availability. Make sure you are signed into GitHub Copilot.');
      }
    }

    // Send status to webview
    if (issues.length > 0) {
      for (const issue of issues) {
        this._view?.webview.postMessage({ command: 'statusWarning', message: issue });
      }
    } else {
      this._view?.webview.postMessage({ command: 'statusOk', message: 'AI ready. Select files to begin.' });
    }
  }

  private async _selectExcelFile(): Promise<void> {
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { 'Excel Files': ['xlsx', 'xls'] },
      title: 'Select CERT-C Report Excel File',
    });

    if (result && result[0]) {
      const filePath = result[0].fsPath;
      this._view?.webview.postMessage({
        command: 'excelSelected',
        path: filePath,
      });

      // Read headers and send to webview for column mapping
      try {
        const headers = await readHeaders(filePath);
        this._view?.webview.postMessage({
          command: 'excelHeaders',
          headers,
        });
      } catch {
        // Silently ignore — validation will catch issues later
      }
    }
  }

  private async _selectProjectFolder(): Promise<void> {
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: 'Select Project Source Folder',
    });

    if (result && result[0]) {
      this._view?.webview.postMessage({
        command: 'folderSelected',
        path: result[0].fsPath,
      });
    }
  }

  private _sendError(error: string): void {
    this._view?.webview.postMessage({ command: 'validationError', error });
    vscode.window.showErrorMessage(error);
  }

  private async _ensureWorkspaceFolder(folderPath: string): Promise<void> {
    const folderUri = vscode.Uri.file(folderPath);
    const folders = vscode.workspace.workspaceFolders ?? [];

    // Check if already in workspace
    const alreadyOpen = folders.some(f => f.uri.fsPath === folderUri.fsPath);
    if (alreadyOpen) { return; }

    // Add to workspace — non-destructive, keeps existing folders
    vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: folderUri });
  }

  private async _startAnalysis(excelPath: string, projectFolder: string, defensiveness?: string, projectContext?: ProjectContext, autoFix?: boolean, skipAnalyzed?: boolean, selectedRows?: Set<number>, reviewFixes?: boolean, columnMapping?: ColumnMapping): Promise<void> {
    if (this._isRunning) {
      vscode.window.showWarningMessage('Analysis is already running.');
      return;
    }

    // --- Pre-flight validation ---

    // 1. Check inputs are provided
    if (!excelPath || !projectFolder) {
      this._sendError('Please select both an Excel file and a project folder.');
      return;
    }

    // 2. Check Excel file exists
    if (!fs.existsSync(excelPath)) {
      this._sendError(`Excel file not found: ${excelPath}`);
      return;
    }

    if (!excelPath.toLowerCase().endsWith('.xlsx') && !excelPath.toLowerCase().endsWith('.xls')) {
      this._sendError('Please select a valid Excel file (.xlsx or .xls).');
      return;
    }

    // 3. Check project folder exists
    if (!fs.existsSync(projectFolder)) {
      this._sendError(`Project folder not found: ${projectFolder}`);
      return;
    }

    if (!fs.statSync(projectFolder).isDirectory()) {
      this._sendError(`The selected path is not a folder: ${projectFolder}`);
      return;
    }

    // 4. Ensure project folder is in workspace (for diagnostics, file navigation, explorer)
    await this._ensureWorkspaceFolder(projectFolder);

    // 5. Validate Excel format (check columns)
    this._view?.webview.postMessage({ command: 'validating', message: 'Checking Excel format...' });
    let warningCount = 0;
    try {
      const warnings = await readWarnings(excelPath, columnMapping);
      warningCount = warnings.length;
      if (warningCount === 0) {
        this._sendError(
          'No warnings found in the Excel file.\n\n' +
          'Please check that:\n' +
          '- The file has a header row with columns: Message, Path, Line-in-Code, Column, Code-Line\n' +
          '- There is at least one data row below the header'
        );
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._sendError(`Excel format error: ${msg}`);
      return;
    }

    // 5. Check AI availability (Copilot installed + signed in)
    this._view?.webview.postMessage({ command: 'validating', message: 'Checking AI availability...' });
    const aiError = await checkAiAvailability();
    if (aiError) {
      this._sendError(aiError);
      return;
    }

    // 6. Estimate token usage
    this._view?.webview.postMessage({ command: 'validating', message: 'Estimating token usage...' });
    const estimate = await estimateTokens(warningCount);
    if (estimate) {
      this._view?.webview.postMessage({
        command: 'tokenEstimate',
        perWarning: estimate.perWarning,
        total: estimate.total,
        modelMax: estimate.modelMax,
        warningCount,
      });
    }

    // Save settings to project config
    const ctx = projectContext ?? { targetPlatform: '', compiler: '', rtos: '', safetyStandard: '', projectNotes: '' };
    saveConfig({
      excelPath,
      projectFolder,
      defensiveness: (defensiveness as ProjectConfig['defensiveness']) ?? 'neutral',
      targetPlatform: ctx.targetPlatform,
      compiler: ctx.compiler,
      rtos: ctx.rtos,
      safetyStandard: ctx.safetyStandard,
      projectNotes: ctx.projectNotes,
      autoFix: !!autoFix,
      reviewFixes: !!reviewFixes,
      skipAnalyzed: skipAnalyzed !== false,
      columnMapping,
    });

    // --- All checks passed, start analysis ---
    this._isRunning = true;
    this._cancellationTokenSource = new vscode.CancellationTokenSource();

    // Store warnings for result callback to reference file paths
    let warningsForResults: WarningRow[] = [];
    try {
      warningsForResults = await readWarnings(excelPath, columnMapping);
    } catch { /* already validated above */ }

    this._view?.webview.postMessage({ command: 'analysisStarted', warningCount });
    this._lastResults = [];
    this._lastExcelPath = excelPath;
    this._lastProjectFolder = projectFolder;
    this._pendingFixes = [];
    clearDiagnostics();

    // Show status bar
    if (this._statusBarItem) {
      this._statusBarItem.text = '$(sync~spin) Cersai: Starting...';
      this._statusBarItem.show();
    }

    try {
      const level = (defensiveness === 'strict' || defensiveness === 'relaxed')
        ? defensiveness : 'neutral';

      const doReviewFixes = !!autoFix && !!reviewFixes;

      const summary = await runAnalysis(
        excelPath,
        projectFolder,
        level,
        ctx,
        !!autoFix,
        selectedRows ? false : (skipAnalyzed !== false),
        selectedRows,
        doReviewFixes,
        true, // Always verify non-critical results with challenger pass
        columnMapping,
        // Progress callback
        (current, total, message) => {
          this._view?.webview.postMessage({
            command: 'progress',
            current,
            total,
            message,
          });
          if (this._statusBarItem) {
            const pct = Math.round((current / total) * 100);
            this._statusBarItem.text = `$(sync~spin) Cersai: ${current}/${total} (${pct}%)`;
          }
        },
        // Result callback
        (rowNumber, result, error) => {
          // Find the warning to get file path and line number
          const warning = warningsForResults.find(w => w.rowNumber === rowNumber);
          this._view?.webview.postMessage({
            command: 'result',
            rowNumber,
            priority: result?.priority ?? null,
            comment: result?.comment ?? null,
            fixApplied: result?.fixApplied ?? false,
            error: error ?? null,
            filePath: warning?.filePath ?? null,
            lineInCode: warning?.lineInCode ?? 0,
          });
          // Collect for report
          if (result) {
            this._lastResults.push({
              rowNumber,
              priority: result.priority,
              comment: result.comment,
              filePath: warning?.filePath ?? '',
              lineInCode: warning?.lineInCode ?? 0,
              fixApplied: result.fixApplied ?? false,
            });
            // Push to VS Code Problems panel
            if (warning) {
              addDiagnostic(
                projectFolder,
                warning.filePath,
                warning.lineInCode,
                result.priority,
                result.comment,
                warning.message
              );
            }
            // Collect pending fixes for diff review
            if (doReviewFixes && result.priority === 'HIGH_PRIO' && result.fixOldCode && result.fixNewCode && warning) {
              this._pendingFixes.push({
                filePath: warning.filePath,
                lineInCode: warning.lineInCode,
                oldCode: result.fixOldCode,
                newCode: result.fixNewCode,
                warningMsg: warning.message,
                rowNumber,
              });
            }
          }
        },
        this._cancellationTokenSource.token
      );

      this._lastSummary = summary;

      this._view?.webview.postMessage({
        command: 'analysisComplete',
        summary,
      });

      if (summary.cancelled) {
        vscode.window.showInformationMessage(
          `Analysis cancelled. Processed ${summary.analyzed}/${summary.total} warnings.`
        );
      } else {
        const upgradedNote = summary.upgraded > 0 ? `, Upgraded: ${summary.upgraded}` : '';
        vscode.window.showInformationMessage(
          `Analysis complete! ${summary.analyzed} warnings processed. ` +
          `HIGH: ${summary.highPrio}, LOW: ${summary.lowPrio}, FP: ${summary.falsePositive}, Fixed: ${summary.fixed}, Errors: ${summary.errors}${upgradedNote}`
        );
      }

      // Show diff review for pending fixes
      if (this._pendingFixes.length > 0) {
        const count = this._pendingFixes.length;
        const action = await vscode.window.showInformationMessage(
          `${count} fix${count > 1 ? 'es' : ''} ready for review. Open diff viewer?`,
          'Review Fixes', 'Skip'
        );
        if (action === 'Review Fixes') {
          await this._reviewPendingFixes(projectFolder, excelPath);
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Analysis failed: ${errorMsg}`);
      this._view?.webview.postMessage({
        command: 'analysisError',
        error: errorMsg,
      });
    } finally {
      this._isRunning = false;
      this._cancellationTokenSource?.dispose();
      this._cancellationTokenSource = undefined;
      resetModelCache();
      if (this._statusBarItem) {
        this._statusBarItem.hide();
      }
    }
  }

  private async _startWithManualSelection(
    excelPath: string,
    projectFolder: string,
    defensiveness?: string,
    projectContext?: ProjectContext,
    autoFix?: boolean,
    skipAnalyzed?: boolean,
    reviewFixes?: boolean,
    columnMapping?: ColumnMapping
  ): Promise<void> {
    if (!excelPath) {
      this._sendError('Please select an Excel file first.');
      return;
    }

    let warnings: WarningRow[];
    try {
      warnings = await readWarnings(excelPath, columnMapping);
    } catch (err) {
      this._sendError(`Excel read error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (warnings.length === 0) {
      this._sendError('No warnings found in the Excel file.');
      return;
    }

    // Extract unique CERT-C rule IDs from warning messages
    // Common patterns: "EXP33-C", "INT31-C", "STR31-C", "ARR38-C", "MISRA-C:2012 Rule 10.4", etc.
    const ruleCountMap = new Map<string, number>();
    const ruleRegex = /([A-Z]{2,5}\d{2}-[A-Z])|MISRA[- ]C:\d{4}\s+Rule\s+\d+\.\d+/g;

    for (const w of warnings) {
      const matches = w.message.match(ruleRegex);
      if (matches) {
        for (const m of matches) {
          ruleCountMap.set(m, (ruleCountMap.get(m) || 0) + 1);
        }
      } else {
        // No rule ID found — group under the first ~40 chars of the message
        const key = w.message.substring(0, 40).trim();
        ruleCountMap.set(key, (ruleCountMap.get(key) || 0) + 1);
      }
    }

    // Build QuickPick items sorted by count (most frequent first)
    const ruleItems = Array.from(ruleCountMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([rule, count]) => ({
        label: rule,
        description: `${count} warning${count > 1 ? 's' : ''}`,
        picked: true, // All selected by default
      }));

    const selected = await vscode.window.showQuickPick(ruleItems, {
      canPickMany: true,
      placeHolder: `Select CERT-C rules to analyze (${ruleItems.length} rules, ${warnings.length} total warnings)`,
      title: 'CERT-C Analyzer: Select Warning Rules',
    });

    if (!selected || selected.length === 0) {
      return; // User cancelled
    }

    // Filter warnings to only those matching selected rules
    const selectedRules = new Set(selected.map(s => s.label));
    const matchingRows = new Set<number>();
    for (const w of warnings) {
      const matches = w.message.match(ruleRegex);
      if (matches) {
        if (matches.some(m => selectedRules.has(m))) {
          matchingRows.add(w.rowNumber);
        }
      } else {
        const key = w.message.substring(0, 40).trim();
        if (selectedRules.has(key)) {
          matchingRows.add(w.rowNumber);
        }
      }
    }

    await this._startAnalysis(excelPath, projectFolder, defensiveness, projectContext, autoFix, skipAnalyzed, matchingRows, reviewFixes, columnMapping);
  }

  private async _reviewPendingFixes(projectRoot: string, excelPath: string): Promise<void> {
    let applied = 0;
    for (let i = 0; i < this._pendingFixes.length; i++) {
      const fix = this._pendingFixes[i];
      const fullPath = path.isAbsolute(fix.filePath)
        ? fix.filePath
        : path.join(projectRoot, fix.filePath);

      if (!fs.existsSync(fullPath)) { continue; }

      const originalContent = fs.readFileSync(fullPath, 'utf-8');
      let proposedContent = originalContent;

      // Apply the fix to get proposed content
      if (originalContent.includes(fix.oldCode)) {
        proposedContent = originalContent.replace(fix.oldCode, fix.newCode);
      } else {
        // Try normalized whitespace match
        const normalizeLines = (s: string) => s.split('\n').map(l => l.trim()).join('\n');
        const normalizedOld = normalizeLines(fix.oldCode);
        const contentLines = originalContent.split('\n');
        const oldLines = normalizedOld.split('\n');
        let found = false;
        for (let j = 0; j <= contentLines.length - oldLines.length; j++) {
          const windowNormalized = contentLines.slice(j, j + oldLines.length).map(l => l.trim()).join('\n');
          if (windowNormalized === normalizedOld) {
            const before = contentLines.slice(0, j).join('\n');
            const after = contentLines.slice(j + oldLines.length).join('\n');
            proposedContent = before + (before ? '\n' : '') + fix.newCode + (after ? '\n' : '') + after;
            found = true;
            break;
          }
        }
        if (!found) { continue; }
      }

      // Show diff
      const originalUri = vscode.Uri.parse(`certc-original:${fullPath}`);
      const proposedUri = vscode.Uri.parse(`certc-proposed:${fullPath}`);

      const originalDoc = await vscode.workspace.openTextDocument(originalUri.with({ scheme: 'untitled', path: fullPath + '.original' }));
      // Use a temp file approach for the diff
      const tmpDir = path.join(projectRoot, '.certc-tmp');
      if (!fs.existsSync(tmpDir)) { fs.mkdirSync(tmpDir, { recursive: true }); }

      const origTmp = path.join(tmpDir, `fix${i}_original.c`);
      const propTmp = path.join(tmpDir, `fix${i}_proposed.c`);
      fs.writeFileSync(origTmp, originalContent, 'utf-8');
      fs.writeFileSync(propTmp, proposedContent, 'utf-8');

      try {
        await vscode.commands.executeCommand('vscode.diff',
          vscode.Uri.file(origTmp),
          vscode.Uri.file(propTmp),
          `Fix ${i + 1}/${this._pendingFixes.length}: ${path.basename(fix.filePath)}:${fix.lineInCode}`
        );

        const action = await vscode.window.showInformationMessage(
          `Fix ${i + 1}/${this._pendingFixes.length} for ${path.basename(fix.filePath)}:${fix.lineInCode}\n${fix.warningMsg.substring(0, 80)}`,
          'Apply Fix', 'Skip', 'Stop Review'
        );

        if (action === 'Apply Fix') {
          fs.writeFileSync(fullPath, proposedContent, 'utf-8');
          applied++;
        } else if (action === 'Stop Review') {
          break;
        }
      } finally {
        // Clean up temp files
        try { fs.unlinkSync(origTmp); } catch {}
        try { fs.unlinkSync(propTmp); } catch {}
      }
    }

    // Clean up temp dir
    const tmpDir = path.join(projectRoot, '.certc-tmp');
    try { fs.rmdirSync(tmpDir); } catch {}

    if (applied > 0) {
      vscode.window.showInformationMessage(`Applied ${applied} fix${applied > 1 ? 'es' : ''}.`);
    }
    this._pendingFixes = [];
  }

  private async _exportReport(): Promise<void> {
    if (!this._lastSummary || this._lastResults.length === 0) {
      vscode.window.showWarningMessage('No analysis results to export. Run an analysis first.');
      return;
    }
    const uri = await vscode.window.showSaveDialog({
      filters: { 'HTML Files': ['html'] },
      defaultUri: vscode.Uri.file(this._lastExcelPath.replace(/\.(xlsx|xls)$/i, '_report.html')),
    });
    if (uri) {
      const html = generateHtmlReport(this._lastSummary, this._lastResults, this._lastExcelPath);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(html, 'utf-8'));
      vscode.window.showInformationMessage(`Report exported to ${uri.fsPath}`);
    }
  }

  private async _openFileAtLine(filePath: string, line: number): Promise<void> {
    if (!filePath) { return; }
    try {
      const resolved = path.isAbsolute(filePath)
        ? filePath
        : path.join(this._lastProjectFolder || '', filePath);
      const uri = vscode.Uri.file(resolved);
      const doc = await vscode.workspace.openTextDocument(uri);
      const lineNum = Math.max(0, (line || 1) - 1);
      const range = new vscode.Range(lineNum, 0, lineNum, 0);
      await vscode.window.showTextDocument(doc, { selection: range, preview: true });
    } catch (err) {
      vscode.window.showWarningMessage(`Could not open file: ${filePath}`);
    }
  }

  private _saveConfig(config: ProjectConfig): void {
    if (saveConfig(config)) {
      this._view?.webview.postMessage({ command: 'configSaved' });
    }
  }

  private async _loadAndSendConfig(): Promise<void> {
    const config = loadConfig();
    if (config) {
      this._view?.webview.postMessage({ command: 'configLoaded', config });

      // Also send headers if Excel path is saved so mapping dropdowns can be populated
      if (config.excelPath && fs.existsSync(config.excelPath)) {
        try {
          const headers = await readHeaders(config.excelPath);
          this._view?.webview.postMessage({ command: 'excelHeaders', headers });
        } catch { /* ignore */ }
      }
    }
  }

  private _cancelAnalysis(): void {
    if (this._cancellationTokenSource) {
      this._cancellationTokenSource.cancel();
      this._view?.webview.postMessage({ command: 'analysisCancelling' });
    }
  }

  public startAnalysis(): void {
    this._view?.webview.postMessage({ command: 'triggerStart' });
  }

  public cancelAnalysis(): void {
    this._cancelAnalysis();
  }

  private _getHtmlContent(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'sidebar.css')
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'sidebar.js')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <link href="${cssUri}" rel="stylesheet">
  <title>Cersai</title>
</head>
<body>
  <div class="container">

    <!-- Files -->
    <div class="section">
      <div class="section-title">Files</div>
      <div class="field">
        <span class="field-label">Excel Report</span>
        <div class="file-input">
          <span id="excelPath" class="file-path">No file selected</span>
          <button id="btnSelectExcel" class="btn btn-secondary">Browse</button>
        </div>
      </div>
      <div class="field">
        <span class="field-label">Project Folder</span>
        <div class="file-input">
          <span id="folderPath" class="file-path">No folder selected</span>
          <button id="btnSelectFolder" class="btn btn-secondary">Browse</button>
        </div>
      </div>
    </div>

    <!-- Column Mapping -->
    <div id="columnMappingSection" class="section column-mapping">
      <div class="section-title">Column Mapping</div>
      <div class="mapping-field">
        <span class="mapping-label">Message</span>
        <select id="mapMessage" class="select-input"><option value="">-- select column --</option></select>
      </div>
      <div class="mapping-field">
        <span class="mapping-label">File Path</span>
        <select id="mapPath" class="select-input"><option value="">-- select column --</option></select>
      </div>
      <div class="mapping-field">
        <span class="mapping-label">Line</span>
        <select id="mapLineInCode" class="select-input"><option value="">-- select column --</option></select>
      </div>
      <div class="mapping-field">
        <span class="mapping-label">Column</span>
        <select id="mapColumn" class="select-input"><option value="">-- select column --</option></select>
      </div>
      <div class="mapping-field">
        <span class="mapping-label">Code Line</span>
        <select id="mapCodeLine" class="select-input"><option value="">-- select column --</option></select>
      </div>
    </div>

    <!-- Settings -->
    <div class="section">
      <div class="section-title">Settings</div>
      <div class="field">
        <span class="field-label">Defensiveness</span>
        <div class="slider-row">
          <input type="range" id="defensivenessSlider" min="1" max="3" step="1" value="2" class="slider">
          <div class="slider-labels">
            <span>Relaxed</span>
            <span>Neutral</span>
            <span>Strict</span>
          </div>
        </div>
      </div>
      <div class="field">
        <span class="field-label">Target Platform</span>
        <input type="text" id="targetPlatformInput" class="text-input" placeholder="e.g. Infineon TC38x, STM32, generic embedded" value="">
      </div>
      <div class="field">
        <span class="field-label">Compiler</span>
        <input type="text" id="compilerInput" class="text-input" placeholder="e.g. Tasking, GCC, Green Hills, ARMCC" value="">
      </div>
      <div class="field">
        <span class="field-label">RTOS / OS</span>
        <input type="text" id="rtosInput" class="text-input" placeholder="e.g. bare-metal, FreeRTOS, AUTOSAR" value="">
      </div>
      <div class="field">
        <span class="field-label">Safety Standard</span>
        <input type="text" id="safetyStandardInput" class="text-input" placeholder="e.g. ASIL-B, ASIL-D, SIL-2, IEC 61508" value="">
      </div>
      <div class="field">
        <span class="field-label">Project Notes</span>
        <textarea id="projectNotesInput" class="text-input text-area" placeholder="e.g. No dynamic allocation, ISRs are masked during critical sections, all pointers validated at API boundary" rows="3"></textarea>
      </div>
      <div class="options-group">
        <label class="checkbox-label">
          <input type="checkbox" id="autoFixCheckbox">
          <span>Auto-fix HIGH_PRIO warnings</span>
        </label>
        <label class="checkbox-label sub-option" id="reviewFixesLabel" style="display:none;">
          <input type="checkbox" id="reviewFixesCheckbox" checked>
          <span>Review fixes in diff before applying</span>
        </label>
        <label class="checkbox-label">
          <input type="checkbox" id="skipAnalyzedCheckbox" checked>
          <span>Skip already-analyzed rows</span>
        </label>
        <label class="checkbox-label">
          <input type="checkbox" id="manualSelectCheckbox">
          <span>Select CERT-C rules to analyze</span>
        </label>
      </div>
    </div>

    <!-- Actions -->
    <div class="action-section">
      <button id="btnStart" class="btn btn-primary" disabled>Start Analysis</button>
      <button id="btnCancel" class="btn btn-danger" style="display:none;">Cancel</button>
    </div>

    <!-- Progress -->
    <div id="progressSection" class="progress-section" style="display:none;">
      <div class="progress-track">
        <div id="progressBar" class="progress-bar" style="width: 0%"></div>
      </div>
      <div id="progressText" class="progress-text">Initializing...</div>
    </div>

    <!-- Summary -->
    <div id="summarySection" class="summary-section" style="display:none;">
      <div class="section-title">Results</div>
      <div class="summary-grid">
        <div class="summary-item">
          <span class="summary-label">Total</span>
          <span id="summaryTotal" class="summary-value">0</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">Analyzed</span>
          <span id="summaryAnalyzed" class="summary-value">0</span>
        </div>
        <div class="summary-item high">
          <span class="summary-label">High</span>
          <span id="summaryHigh" class="summary-value">0</span>
        </div>
        <div class="summary-item low">
          <span class="summary-label">Low</span>
          <span id="summaryLow" class="summary-value">0</span>
        </div>
        <div class="summary-item fp">
          <span class="summary-label">False Pos</span>
          <span id="summaryFP" class="summary-value">0</span>
        </div>
        <div class="summary-item fixed">
          <span class="summary-label">Fixed</span>
          <span id="summaryFixed" class="summary-value">0</span>
        </div>
        <div class="summary-item upgraded">
          <span class="summary-label">Upgraded</span>
          <span id="summaryUpgraded" class="summary-value">0</span>
        </div>
        <div class="summary-item error">
          <span class="summary-label">Errors</span>
          <span id="summaryErrors" class="summary-value">0</span>
        </div>
      </div>
    </div>

    <!-- Export -->
    <div id="exportSection" style="display:none;">
      <button id="btnExport" class="btn btn-outline">Export HTML Report</button>
    </div>

    <!-- Log -->
    <div id="logSection" class="log-section">
      <div class="section-title">Log</div>
      <div id="logContainer" class="log-container"></div>
    </div>

  </div>

  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
