import * as fs from 'fs';
import * as path from 'path';

const MAX_CONTEXT_CHARS = 12000;
const MAX_CALL_DEPTH = 3;

// ----- File index (built once per analysis run) -----

interface FileIndex {
  projectRoot: string;
  files: string[];                          // all .c/.h paths
  contentMap: Map<string, string>;          // path -> content
  linesMap: Map<string, string[]>;          // path -> lines
  functionDefs: Map<string, FuncLocation>;  // funcName -> location
  typeDefs: Map<string, DefLocation>;       // typeName -> location
  macroDefs: Map<string, DefLocation>;      // macroName -> location
  globalDefs: Map<string, DefLocation>;     // globalVar -> location
}

interface FuncLocation {
  file: string;
  startLine: number;
  endLine: number;
  signature: string;
}

interface DefLocation {
  file: string;
  startLine: number;
  endLine: number;
}

let cachedIndex: FileIndex | null = null;

export function clearFileCache(): void {
  cachedIndex = null;
}

// ----- Build full project index -----

function getOrBuildIndex(projectRoot: string): FileIndex {
  if (cachedIndex && cachedIndex.projectRoot === projectRoot) {
    return cachedIndex;
  }

  const files = findSourceFiles(projectRoot);
  const contentMap = new Map<string, string>();
  const linesMap = new Map<string, string[]>();
  const functionDefs = new Map<string, FuncLocation>();
  const typeDefs = new Map<string, DefLocation>();
  const macroDefs = new Map<string, DefLocation>();
  const globalDefs = new Map<string, DefLocation>();

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    contentMap.set(file, content);
    const lines = content.split('\n');
    linesMap.set(file, lines);

    // Index all function definitions
    indexFunctions(file, lines, functionDefs);

    // Index typedefs, structs, enums
    indexTypeDefs(file, lines, content, typeDefs);

    // Index macros
    indexMacroDefs(file, lines, macroDefs);

    // Index global/static variables (file-scope declarations)
    indexGlobals(file, lines, globalDefs);
  }

  cachedIndex = { projectRoot, files, contentMap, linesMap, functionDefs, typeDefs, macroDefs, globalDefs };
  return cachedIndex;
}

function indexFunctions(file: string, lines: string[], map: Map<string, FuncLocation>): void {
  // Find function definitions: look for patterns like `type funcname(...)  {`
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip preprocessor, comments, blank lines
    if (line.trim().startsWith('#') || line.trim().startsWith('//') || line.trim().startsWith('/*') || line.trim() === '') {
      continue;
    }

    // Match function definition: identifier followed by ( at start of line area
    // Must not be inside a function body (brace depth 0)
    const funcMatch = line.match(/^[\w\s\*]+?\b(\w+)\s*\(([^)]*)\)\s*\{?\s*$/);
    if (funcMatch && !isControlKeyword(funcMatch[1])) {
      const funcName = funcMatch[1];

      // Find the opening brace
      let braceLineIdx = i;
      if (!line.includes('{')) {
        // Look at next few lines for the opening brace
        for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
          if (lines[j].includes('{')) {
            braceLineIdx = j;
            break;
          }
        }
      }

      // Find closing brace
      let braceDepth = 0;
      let endLine = braceLineIdx;
      for (let j = braceLineIdx; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') { braceDepth++; }
          if (ch === '}') {
            braceDepth--;
            if (braceDepth === 0) {
              endLine = j;
              break;
            }
          }
        }
        if (braceDepth === 0 && endLine >= braceLineIdx) { break; }
      }

      // Get the full signature (may span multiple lines)
      const sigLines = lines.slice(i, braceLineIdx + 1);
      const signature = sigLines.map(l => l.trim()).join(' ').replace(/\{.*$/, '').trim();

      if (!map.has(funcName)) {
        map.set(funcName, { file, startLine: i, endLine, signature });
      }
    }
  }
}

function indexTypeDefs(file: string, lines: string[], content: string, map: Map<string, DefLocation>): void {
  // typedef ... name;
  const typedefPattern = /typedef\s+[\s\S]*?\b(\w+)\s*;/g;
  let match;
  while ((match = typedefPattern.exec(content)) !== null) {
    const name = match[1];
    const startLine = content.substring(0, match.index).split('\n').length - 1;
    const endLine = content.substring(0, match.index + match[0].length).split('\n').length - 1;
    if (!map.has(name)) {
      map.set(name, { file, startLine, endLine });
    }
  }

  // struct/enum/union name { ... }
  const structPattern = /(?:struct|enum|union)\s+(\w+)\s*\{/g;
  while ((match = structPattern.exec(content)) !== null) {
    const name = match[1];
    const startLine = content.substring(0, match.index).split('\n').length - 1;
    // Find closing brace
    let braceDepth = 0;
    let endLine = startLine;
    for (let j = startLine; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') { braceDepth++; }
        if (ch === '}') {
          braceDepth--;
          if (braceDepth === 0) { endLine = j; break; }
        }
      }
      if (braceDepth === 0 && j > startLine) { break; }
    }
    if (!map.has(name)) {
      map.set(name, { file, startLine, endLine });
    }
  }
}

function indexMacroDefs(file: string, lines: string[], map: Map<string, DefLocation>): void {
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*#define\s+(\w+)/);
    if (match) {
      const name = match[1];
      // Handle multi-line macros with backslash
      let endLine = i;
      while (endLine < lines.length - 1 && lines[endLine].trimEnd().endsWith('\\')) {
        endLine++;
      }
      if (!map.has(name)) {
        map.set(name, { file, startLine: i, endLine });
      }
    }
  }
}

function indexGlobals(file: string, lines: string[], map: Map<string, DefLocation>): void {
  let braceDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track brace depth to skip function bodies
    for (const ch of line) {
      if (ch === '{') { braceDepth++; }
      if (ch === '}') { braceDepth--; }
    }

    // Only at file scope (braceDepth 0)
    if (braceDepth !== 0) { continue; }

    // Match global/static variable: `[static] [volatile] [const] type name [= ...];`
    const globalMatch = line.match(/^(?:static\s+|volatile\s+|const\s+)*\w[\w\s\*]*\b(\w+)\s*(?:=|;|\[)/);
    if (globalMatch && !isControlKeyword(globalMatch[1]) && !line.trim().startsWith('#') && !line.includes('(')) {
      const name = globalMatch[1];
      if (!map.has(name)) {
        map.set(name, { file, startLine: i, endLine: i });
      }
    }
  }
}

// ----- Main entry points -----

export async function getCodeContext(
  projectRoot: string,
  filePath: string,
  line: number
): Promise<string> {
  const index = getOrBuildIndex(projectRoot);
  const fullPath = resolveFilePath(projectRoot, filePath);
  const lines = index.linesMap.get(fullPath);

  if (!lines) {
    return `[File not found: ${filePath}]`;
  }

  if (line < 1 || line > lines.length) {
    return `[Line ${line} out of range for ${filePath} (${lines.length} lines)]`;
  }

  // Extract the COMPLETE enclosing function
  const funcRange = findEnclosingFunctionRange(lines, line - 1);
  return formatFunctionContext(lines, funcRange, line, filePath);
}

export async function findRelatedDefinitions(
  projectRoot: string,
  codeContext: string,
  warningFilePath: string,
  warningLine: number
): Promise<string> {
  const index = getOrBuildIndex(projectRoot);
  const sections: string[] = [];
  const included = new Set<string>();

  // 1. Get all identifiers from the enclosing function
  const allIdentifiers = extractAllIdentifiers(codeContext);

  // 2. Get function calls from the enclosing function
  const calledFunctions = extractFunctionCalls(codeContext);

  // 3. Get the enclosing function name
  const enclosingFunc = extractEnclosingFuncName(codeContext);

  // --- A. Include full source of called functions (and THEIR callees, recursively) ---
  const funcQueue: { name: string; depth: number }[] = calledFunctions.map(n => ({ name: n, depth: 0 }));
  const visitedFuncs = new Set<string>();
  if (enclosingFunc) { visitedFuncs.add(enclosingFunc); } // skip self

  while (funcQueue.length > 0 && sections.length < 15) {
    const { name, depth } = funcQueue.shift()!;
    if (visitedFuncs.has(name) || depth > MAX_CALL_DEPTH) { continue; }
    visitedFuncs.add(name);

    const funcLoc = index.functionDefs.get(name);
    if (!funcLoc) { continue; }

    const funcLines = index.linesMap.get(funcLoc.file);
    if (!funcLines) { continue; }

    const snippet = funcLines.slice(funcLoc.startLine, funcLoc.endLine + 1).join('\n');
    const relPath = path.relative(projectRoot, funcLoc.file);
    const key = `func:${name}`;
    if (!included.has(key)) {
      included.add(key);
      const label = depth === 0 ? 'Called function' : `Called function (depth ${depth})`;
      const truncated = truncateSnippet(snippet, 2500);
      sections.push(`// ${label}: ${name}() in ${relPath} (line ${funcLoc.startLine + 1})\n${truncated}`);

      // Queue callees of this function for deeper tracing
      if (depth < MAX_CALL_DEPTH) {
        const nestedCalls = extractFunctionCallsFromText(snippet);
        for (const nc of nestedCalls) {
          if (!visitedFuncs.has(nc)) {
            funcQueue.push({ name: nc, depth: depth + 1 });
          }
        }
      }
    }
  }

  // --- B. Find callers of the enclosing function (call history / how we got here) ---
  if (enclosingFunc) {
    const callers = findCallersDeep(enclosingFunc, index, MAX_CALL_DEPTH);
    for (const caller of callers.slice(0, 3)) {
      if (sections.length >= 15) { break; }
      sections.push(caller);
    }
  }

  // --- C. Include type definitions used in the context ---
  for (const id of allIdentifiers) {
    if (sections.length >= 18) { break; }
    const typeLoc = index.typeDefs.get(id);
    if (typeLoc) {
      const key = `type:${id}`;
      if (!included.has(key)) {
        included.add(key);
        const typeLines = index.linesMap.get(typeLoc.file);
        if (typeLines) {
          const snippet = typeLines.slice(typeLoc.startLine, typeLoc.endLine + 1).join('\n');
          const relPath = path.relative(projectRoot, typeLoc.file);
          sections.push(`// Type definition: ${id} in ${relPath} (line ${typeLoc.startLine + 1})\n${snippet}`);
        }
      }
    }
  }

  // --- D. Include macro definitions used in the context ---
  for (const id of allIdentifiers) {
    if (sections.length >= 20) { break; }
    const macroLoc = index.macroDefs.get(id);
    if (macroLoc) {
      const key = `macro:${id}`;
      if (!included.has(key)) {
        included.add(key);
        const macroLines = index.linesMap.get(macroLoc.file);
        if (macroLines) {
          const snippet = macroLines.slice(macroLoc.startLine, macroLoc.endLine + 1).join('\n');
          const relPath = path.relative(projectRoot, macroLoc.file);
          sections.push(`// Macro: ${id} in ${relPath} (line ${macroLoc.startLine + 1})\n${snippet}`);
        }
      }
    }
  }

  // --- E. Include global/static variable definitions used in the context ---
  for (const id of allIdentifiers) {
    if (sections.length >= 22) { break; }
    const globalLoc = index.globalDefs.get(id);
    if (globalLoc) {
      const key = `global:${id}`;
      if (!included.has(key)) {
        included.add(key);
        const globalLines = index.linesMap.get(globalLoc.file);
        if (globalLines) {
          const snippet = globalLines.slice(globalLoc.startLine, globalLoc.endLine + 1).join('\n');
          const relPath = path.relative(projectRoot, globalLoc.file);
          sections.push(`// Global variable: ${id} in ${relPath} (line ${globalLoc.startLine + 1})\n${snippet}`);
        }
      }
    }
  }

  // --- F. Include relevant #includes from the warning file ---
  const fullPath = resolveFilePath(projectRoot, warningFilePath);
  const fileContent = index.contentMap.get(fullPath);
  if (fileContent) {
    const includes = fileContent.match(/^\s*#include\s+"[^"]+"/gm);
    if (includes) {
      const includeList = includes.map(i => i.trim()).join('\n');
      sections.unshift(`// Includes from ${warningFilePath}:\n${includeList}`);
    }
  }

  // Assemble and trim
  let result = sections.join('\n\n');
  if (result.length > MAX_CONTEXT_CHARS) {
    result = result.substring(0, MAX_CONTEXT_CHARS) + '\n// ... (context truncated to fit token budget)';
  }

  return result;
}

// ----- Call chain tracing -----

function findCallersDeep(funcName: string, index: FileIndex, maxDepth: number): string[] {
  const results: string[] = [];
  const visited = new Set<string>();
  visited.add(funcName);

  let currentTargets = [funcName];

  for (let depth = 0; depth < maxDepth && currentTargets.length > 0; depth++) {
    const nextTargets: string[] = [];

    for (const target of currentTargets) {
      const escaped = escapeRegex(target);
      const callPattern = new RegExp(`\\b${escaped}\\s*\\(`, 'g');

      for (const [file, content] of index.contentMap) {
        if (!callPattern.test(content)) { continue; }
        callPattern.lastIndex = 0;

        const lines = index.linesMap.get(file)!;
        let match;

        while ((match = callPattern.exec(content)) !== null) {
          const callLineIdx = content.substring(0, match.index).split('\n').length - 1;

          // Find enclosing function of this call site
          const callerRange = findEnclosingFunctionRange(lines, callLineIdx);
          if (callerRange.name && !visited.has(callerRange.name)) {
            visited.add(callerRange.name);

            const snippet = lines.slice(callerRange.startLine, callerRange.endLine + 1).join('\n');
            const relPath = path.relative(index.projectRoot, file);
            const label = depth === 0 ? 'Direct caller' : `Caller (depth ${depth + 1})`;
            const truncated = truncateSnippet(snippet, 2000);
            results.push(`// ${label}: ${callerRange.name}() calls ${target}() — in ${relPath}\n${truncated}`);
            nextTargets.push(callerRange.name);
            break; // one caller per file per target
          }
        }
      }

      if (results.length >= 4) { break; }
    }

    currentTargets = nextTargets;
    if (results.length >= 4) { break; }
  }

  return results;
}

// ----- Function range extraction -----

interface FunctionRange {
  name: string | null;
  startLine: number;
  endLine: number;
}

function findEnclosingFunctionRange(lines: string[], targetLine: number): FunctionRange {
  let braceDepth = 0;
  let funcOpenBrace = -1;

  for (let i = targetLine; i >= 0; i--) {
    const line = lines[i];
    for (let c = line.length - 1; c >= 0; c--) {
      if (line[c] === '}') { braceDepth++; }
      if (line[c] === '{') {
        braceDepth--;
        if (braceDepth < 0) {
          funcOpenBrace = i;
          break;
        }
      }
    }
    if (funcOpenBrace >= 0) { break; }
  }

  if (funcOpenBrace < 0) {
    const start = Math.max(0, targetLine - 10);
    const end = Math.min(lines.length - 1, targetLine + 10);
    return { name: null, startLine: start, endLine: end };
  }

  // Find signature start
  let sigStart = funcOpenBrace;
  for (let i = funcOpenBrace; i >= Math.max(0, funcOpenBrace - 10); i--) {
    const trimmed = lines[i].trim();
    if (i < funcOpenBrace && (trimmed === '' || trimmed === '}' || trimmed.startsWith('#'))) {
      sigStart = i + 1;
      break;
    }
    sigStart = i;
  }

  // Find function name
  let funcName: string | null = null;
  for (let i = sigStart; i <= funcOpenBrace; i++) {
    const nameMatch = lines[i].match(/(\w+)\s*\(/);
    if (nameMatch && !isControlKeyword(nameMatch[1])) {
      funcName = nameMatch[1];
      break;
    }
  }

  // Find closing brace
  braceDepth = 0;
  let funcCloseBrace = lines.length - 1;
  for (let i = funcOpenBrace; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { braceDepth++; }
      if (ch === '}') {
        braceDepth--;
        if (braceDepth === 0) { funcCloseBrace = i; break; }
      }
    }
    if (braceDepth === 0 && i >= funcOpenBrace) { break; }
  }

  return { name: funcName, startLine: sigStart, endLine: funcCloseBrace };
}

function formatFunctionContext(lines: string[], range: FunctionRange, warningLine: number, filePath: string): string {
  const header = range.name
    ? `// File: ${filePath} | Function: ${range.name}() | Warning at line ${warningLine}`
    : `// File: ${filePath} | Warning at line ${warningLine}`;

  const contextLines = lines.slice(range.startLine, range.endLine + 1).map((l, i) => {
    const lineNum = range.startLine + i + 1;
    const marker = lineNum === warningLine ? ' >>>' : '    ';
    return `${marker} ${lineNum}: ${l}`;
  });

  return `${header}\n${contextLines.join('\n')}`;
}

// ----- Identifier extraction -----

function extractAllIdentifiers(context: string): string[] {
  const ids: string[] = [];
  // Priority: warning line identifiers first
  const warningMatch = context.match(/>>>\s*\d+:\s*(.*)/);
  if (warningMatch) { extractIds(warningMatch[1], ids); }
  // Then all identifiers from the function
  extractIds(context, ids);
  return ids;
}

function extractFunctionCalls(context: string): string[] {
  return extractFunctionCallsFromText(context);
}

function extractFunctionCallsFromText(text: string): string[] {
  const calls: string[] = [];
  const pattern = /\b([A-Za-z_]\w+)\s*\(/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1];
    if (!isControlKeyword(name) && !STDLIB_FUNCS.has(name) && !calls.includes(name)) {
      calls.push(name);
    }
  }
  return calls;
}

function extractEnclosingFuncName(context: string): string | null {
  const m = context.match(/Function:\s*(\w+)\(\)/);
  return m ? m[1] : null;
}

function extractIds(text: string, results: string[]): void {
  const pattern = /\b([A-Za-z_]\w{2,})\b/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const id = match[1];
    if (!C_KEYWORDS.has(id) && !results.includes(id)) {
      results.push(id);
    }
  }
}

// ----- Utilities -----

function resolveFilePath(projectRoot: string, filePath: string): string {
  if (path.isAbsolute(filePath)) { return filePath; }
  return path.join(projectRoot, filePath);
}

function truncateSnippet(text: string, maxLen: number): string {
  if (text.length <= maxLen) { return text; }
  return text.substring(0, maxLen) + '\n// ... (truncated)';
}

function isControlKeyword(word: string): boolean {
  return ['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'return', 'sizeof', 'typeof', 'default', 'goto'].includes(word);
}

function findSourceFiles(dir: string, maxDepth: number = 10): string[] {
  const files: string[] = [];
  const visited = new Set<string>();

  function walk(currentDir: string, depth: number) {
    if (depth > maxDepth || visited.has(currentDir)) { return; }
    visited.add(currentDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'build' || entry.name === 'output' || entry.name === '__pycache__') {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile() && /\.[ch]$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  walk(dir, 0);
  return files;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const C_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'return', 'void', 'int', 'char', 'float', 'double', 'long', 'short',
  'unsigned', 'signed', 'const', 'static', 'extern', 'volatile', 'struct',
  'union', 'enum', 'typedef', 'sizeof', 'NULL', 'true', 'false', 'inline',
  'register', 'restrict', 'auto', 'goto', 'default',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'size_t', 'ssize_t', 'bool', 'boolean',
]);

const STDLIB_FUNCS = new Set([
  'memset', 'memcpy', 'memmove', 'memcmp', 'malloc', 'calloc', 'realloc', 'free',
  'strlen', 'strcpy', 'strncpy', 'strcat', 'strncat', 'strcmp', 'strncmp', 'strstr',
  'printf', 'sprintf', 'snprintf', 'fprintf', 'scanf', 'sscanf',
  'fopen', 'fclose', 'fread', 'fwrite', 'fgets', 'fputs',
  'abs', 'atoi', 'atol', 'atof', 'strtol', 'strtoul',
  'assert', 'exit', 'abort',
]);
