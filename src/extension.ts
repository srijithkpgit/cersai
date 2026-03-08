import * as vscode from 'vscode';
import { SidebarProvider } from './SidebarProvider';
import { initDiagnostics, disposeDiagnostics } from './diagnosticsService';

let sidebarProvider: SidebarProvider;

export function activate(context: vscode.ExtensionContext) {
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'certcAnalyzer.startAnalysis';
  context.subscriptions.push(statusBarItem);

  const diagnosticCollection = initDiagnostics();
  context.subscriptions.push(diagnosticCollection);

  sidebarProvider = new SidebarProvider(context.extensionUri, statusBarItem);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('certcAnalyzer.sidebar', sidebarProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('certcAnalyzer.startAnalysis', () => {
      sidebarProvider.startAnalysis();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('certcAnalyzer.cancelAnalysis', () => {
      sidebarProvider.cancelAnalysis();
    })
  );
}

export function deactivate() {
  disposeDiagnostics();
}
