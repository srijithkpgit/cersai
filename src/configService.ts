import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ColumnMapping } from './types';

export interface ProjectConfig {
  excelPath?: string;
  projectFolder?: string;
  defensiveness?: 'relaxed' | 'neutral' | 'strict';
  targetPlatform?: string;
  compiler?: string;
  rtos?: string;
  safetyStandard?: string;
  projectNotes?: string;
  autoFix?: boolean;
  reviewFixes?: boolean;
  skipAnalyzed?: boolean;
  manualSelect?: boolean;
  pathFilter?: string;
  analyserName?: string;
  columnMapping?: ColumnMapping;
}

const CONFIG_FILENAME = '.certc-analyzer.json';

/**
 * Find the config file by searching the workspace folders.
 */
function findConfigPath(): string | null {
  const folders = vscode.workspace?.workspaceFolders;
  if (folders && folders.length > 0) {
    for (const folder of folders) {
      const configPath = path.join(folder.uri.fsPath, CONFIG_FILENAME);
      if (fs.existsSync(configPath)) {
        return configPath;
      }
    }
    // Return the path in the first workspace folder (for saving)
    return path.join(folders[0].uri.fsPath, CONFIG_FILENAME);
  }
  return null;
}

export function loadConfig(): ProjectConfig | null {
  const configPath = findConfigPath();
  if (!configPath || !fs.existsSync(configPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as ProjectConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: ProjectConfig): boolean {
  const configPath = findConfigPath();
  if (!configPath) {
    return false;
  }

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return true;
  } catch {
    return false;
  }
}
