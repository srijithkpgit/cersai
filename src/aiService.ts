import * as vscode from 'vscode';
import { WarningRow, AnalysisResult, DefensivenessLevel, ProjectContext } from './types';

function getSystemPrompt(ctx: ProjectContext): string {
  // Build environment description from project context
  const envParts: string[] = [];
  if (ctx.targetPlatform) { envParts.push(`Target platform: ${ctx.targetPlatform}`); }
  if (ctx.compiler) { envParts.push(`Compiler: ${ctx.compiler}`); }
  if (ctx.rtos) { envParts.push(`RTOS/OS: ${ctx.rtos}`); }
  if (ctx.safetyStandard) { envParts.push(`Safety standard: ${ctx.safetyStandard}`); }

  const envBlock = envParts.length > 0
    ? `\n\nProject environment:\n${envParts.map(p => '- ' + p).join('\n')}`
    : '';

  const notesBlock = ctx.projectNotes
    ? `\n\nProject-specific notes from the developer:\n${ctx.projectNotes}`
    : '';

  const safetyNote = ctx.safetyStandard
    ? ` The project must comply with ${ctx.safetyStandard}, so apply the corresponding level of rigor to your analysis.`
    : '';

  return `You are an expert C code static analysis assistant specializing in CERT-C, MISRA C, and QAC warnings.${envBlock}${notesBlock}

When analyzing a warning, follow this 6-step workflow:

Step 1 - Define the Warning Rule: Explain the general principle of the warning rule and what category of error or risk it prevents. Reference the specific CERT-C/MISRA rule if identifiable.

Step 2 - Analyze Immediate Code Context: Analyze the provided line of code and the function it resides in. Identify the key variables, function calls, and operations involved.

Step 3 - Trace the Root Cause: Investigate the origin of the state that triggered the warning. Trace variables back to their declarations and last modifications. Analyze function return values and side effects. Consider ALL callers and ALL possible execution paths, not just the happy path.

Step 4 - Functional and Security Impact Assessment: Evaluate the actual impact:
- Functional: Is this a definite bug? Could it lead to incorrect calculations, crashes, or undefined behavior?
- Security: Could this indicate buffer overflows, integer overflows, data leakage, denial of service, or insecure state?
- Consider edge cases: What happens with boundary values, NULL pointers, maximum array sizes, concurrent access, or unexpected input?
- Consider platform-specific behavior: Could this behave differently on the target platform vs. a desktop system?${ctx.compiler ? `\n- Consider compiler-specific behavior: Does ${ctx.compiler} handle this construct in a non-standard or platform-specific way?` : ''}${ctx.rtos ? `\n- Consider RTOS context: In a ${ctx.rtos} environment, could this be called from an ISR, a different task priority, or a critical section?` : ''}

Step 5 - Self-Challenge (Devil's Advocate): BEFORE deciding your priority, argue AGAINST your initial conclusion:
- If you are leaning toward LOW_PRIO or FALSE_POSITIVE, list specific scenarios where this code COULD fail or cause harm. Consider: untested edge cases, future code changes that could break assumptions, interrupt handlers modifying shared state, multi-core race conditions, compiler optimizations changing behavior.
- If you cannot find ANY realistic failure scenario, only then classify as LOW_PRIO or FALSE_POSITIVE.
- If you find even ONE plausible failure scenario that isn't explicitly guarded against in the code, classify as HIGH_PRIO.

Step 6 - Recommend Action: Either provide a code fix with explanation, or provide a formal justification that the warning is non-critical/false positive. The justification must address every failure scenario from Step 5.${safetyNote}

CRITICAL RULES:
- Do NOT dismiss a warning just because the code "looks correct" at first glance. Static analyzers flag real patterns of risk.
- Do NOT assume variables are always in valid ranges unless you can see explicit validation in the provided code.
- Do NOT assume functions always succeed unless error handling is visible.
- When you lack information about callers, data flow, or initialization, assume the WORST CASE — classify as HIGH_PRIO.
- Missing context is a reason to classify HIGH, not LOW. The static analyzer saw something you might be missing.

IMPORTANT: You MUST respond in this exact JSON format and nothing else:
{
  "priority": "HIGH_PRIO" or "LOW_PRIO" or "FALSE_POSITIVE",
  "comment": "your detailed multi-step analysis here",
  "fixOldCode": "the exact original code that needs to be replaced (only for HIGH_PRIO)",
  "fixNewCode": "the corrected code to replace it with (only for HIGH_PRIO)"
}

For HIGH_PRIO warnings, you MUST provide fixOldCode and fixNewCode fields:
- fixOldCode: Copy the exact lines from the source code that need to change (whitespace-exact match)
- fixNewCode: The corrected version of those lines
- Keep the fix minimal — only the lines that actually need to change
- For LOW_PRIO and FALSE_POSITIVE, omit fixOldCode and fixNewCode

Priority guidelines:
- HIGH_PRIO: Definite bug, security vulnerability, undefined behavior, code that requires a fix, OR any warning where you cannot prove with certainty that it is safe
- LOW_PRIO: The warning is valid, but you have CONCRETE EVIDENCE in the provided code that proves there is no functional or security impact in this specific embedded system context
- FALSE_POSITIVE: The warning is provably not applicable — you can point to specific code that makes the static checker's concern impossible`;
}

let cachedModel: vscode.LanguageModelChat | null = null;

/**
 * Check if GitHub Copilot is available and the user is signed in.
 * Returns a user-friendly error message or null if everything is OK.
 */
export async function checkAiAvailability(): Promise<string | null> {
  // First do a quick check: is the Copilot extension even installed?
  const copilotExt = vscode.extensions.getExtension('GitHub.copilot');
  if (!copilotExt) {
    return 'GitHub Copilot extension is not installed.\n\nTo fix this:\n1. Open Extensions panel (Ctrl+Shift+X / Cmd+Shift+X)\n2. Search for "GitHub Copilot"\n3. Install it and sign in with your GitHub account';
  }

  try {
    // Add a 10-second timeout so the UI doesn't hang forever
    const modelsPromise = vscode.lm.selectChatModels({ vendor: 'copilot' });
    const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000));

    const models = await Promise.race([modelsPromise, timeoutPromise]);

    if (models === null) {
      return 'AI availability check timed out.\n\nPlease ensure you are signed into GitHub. Click the person icon in the bottom-left corner of VS Code to sign in.';
    }

    if (!models || models.length === 0) {
      return 'No AI language model available.\n\nPlease ensure you are signed into GitHub Copilot with an active subscription. Click the person/account icon in the bottom-left corner of VS Code to sign in.';
    }

    return null; // All good
  } catch (err) {
    if (err instanceof vscode.LanguageModelError) {
      if (err.code === 'NoPermissions') {
        return 'Copilot access was denied. Please allow the CERT-C Analyzer extension to use GitHub Copilot when prompted.';
      }
      return `Copilot error: ${err.message}`;
    }
    return `Failed to check AI availability: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function getModel(): Promise<vscode.LanguageModelChat> {
  if (cachedModel) {
    return cachedModel;
  }

  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });

  if (!models || models.length === 0) {
    const copilotExt = vscode.extensions.getExtension('GitHub.copilot');
    if (!copilotExt) {
      throw new Error(
        'GitHub Copilot extension is not installed.\n\n' +
        'To fix this:\n' +
        '1. Open the Extensions panel (Ctrl+Shift+X)\n' +
        '2. Search for "GitHub Copilot"\n' +
        '3. Install and sign in with your GitHub account'
      );
    }
    throw new Error(
      'No AI language model available.\n\n' +
      'Possible causes:\n' +
      '- You are not signed into GitHub (check the account icon in the bottom-left)\n' +
      '- Your GitHub Copilot subscription is inactive\n' +
      '- The Copilot extension is not fully loaded yet (try reloading VS Code)'
    );
  }

  // Prefer gpt-4o, fall back to whatever is available
  cachedModel = models.find(m => m.family === 'gpt-4o') ?? models[0];
  return cachedModel;
}

export async function analyzeWarning(
  warning: WarningRow,
  codeContext: string,
  relatedDefinitions: string,
  defensiveness: DefensivenessLevel,
  projectContext: ProjectContext,
  cancellationToken: vscode.CancellationToken
): Promise<AnalysisResult> {
  const model = await getModel();
  const systemPrompt = getSystemPrompt(projectContext);

  const userPrompt = buildPrompt(warning, codeContext, relatedDefinitions, defensiveness, projectContext);

  const messages = [
    vscode.LanguageModelChatMessage.User(systemPrompt),
    vscode.LanguageModelChatMessage.User(userPrompt),
  ];

  // Check token budget
  const fullText = systemPrompt + '\n' + userPrompt;
  const tokenCount = await model.countTokens(fullText);
  if (tokenCount > model.maxInputTokens * 0.9) {
    // Truncate context to fit
    const truncatedContext = codeContext.substring(0, Math.floor(codeContext.length * 0.5));
    const truncatedPrompt = buildPrompt(warning, truncatedContext, '', defensiveness, projectContext);
    messages[1] = vscode.LanguageModelChatMessage.User(truncatedPrompt);
  }

  try {
    const response = await model.sendRequest(
      messages,
      { justification: 'Analyzing CERT-C static analysis warning' },
      cancellationToken
    );

    // Accumulate streaming response
    let fullResponse = '';
    for await (const fragment of response.text) {
      fullResponse += fragment;
    }

    if (!fullResponse.trim()) {
      throw new Error('AI returned an empty response. This may be due to rate limiting. Please try again.');
    }

    return parseResponse(fullResponse);
  } catch (err) {
    if (err instanceof vscode.LanguageModelError) {
      switch (err.code) {
        case 'NoPermissions':
          throw new Error('Copilot access denied. Please allow the extension to use Copilot when prompted.');
        case 'Blocked':
          throw new Error('Request was blocked by the content filter. The code context may contain flagged content. Skipping this warning.');
        case 'NotFound':
          throw new Error('The AI model is no longer available. Try reloading VS Code.');
        default:
          throw new Error(`AI error (${err.code}): ${err.message}`);
      }
    }
    throw err;
  }
}

function getDefensivenessInstruction(level: DefensivenessLevel): string {
  switch (level) {
    case 'strict':
      return `\n\n**Analysis Mode: STRICT (Defensive)**
Apply a highly defensive analysis approach. When in doubt, classify the warning as HIGH_PRIO. Assume the worst-case scenario for all potential issues. Even if the code appears safe in the current context, consider edge cases, future modifications, and platform-specific behavior. Prefer recommending a code fix over justifying the warning as safe. Only classify as LOW_PRIO or FALSE_POSITIVE when you have absolute certainty that no risk exists.`;
    case 'relaxed':
      return `\n\n**Analysis Mode: RELAXED**
Apply a lenient analysis approach. Focus only on warnings that represent clear, definite bugs or security vulnerabilities. If the code works correctly in the current context and the warning is about theoretical risks that are unlikely in this specific embedded system, classify it as LOW_PRIO or FALSE_POSITIVE. Only classify as HIGH_PRIO when there is a concrete, demonstrable bug or security issue. Give the developer the benefit of the doubt.`;
    default:
      return '';
  }
}

function buildPrompt(
  warning: WarningRow,
  codeContext: string,
  relatedDefinitions: string,
  defensiveness: DefensivenessLevel,
  ctx: ProjectContext
): string {
  let prompt = `Analyze this static analysis warning for ${ctx.targetPlatform ? 'a ' + ctx.targetPlatform + ' system' : 'an embedded system'}.

**Warning:** ${warning.message}
**File:** ${warning.filePath}
**Line:** ${warning.lineInCode}
**Code:** \`${warning.codeLine}\`

**Surrounding Code Context:**
\`\`\`c
${codeContext}
\`\`\``;

  if (relatedDefinitions) {
    prompt += `

**Related Definitions:**
\`\`\`c
${relatedDefinitions}
\`\`\``;
  }

  prompt += getDefensivenessInstruction(defensiveness);

  prompt += `

Respond with ONLY a valid JSON object in this format:
{
  "priority": "HIGH_PRIO" or "LOW_PRIO" or "FALSE_POSITIVE",
  "comment": "Step 1: [rule explanation]\\nStep 2: [context analysis]\\nStep 3: [root cause]\\nStep 4: [impact assessment]\\nStep 5: [recommendation]",
  "fixOldCode": "exact original code lines to replace (HIGH_PRIO only)",
  "fixNewCode": "corrected code (HIGH_PRIO only)"
}`;

  return prompt;
}

function parseResponse(response: string): AnalysisResult {
  // Strip markdown code fences (```json ... ```) if present
  let cleaned = response.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Try direct JSON.parse first (handles clean responses)
  const candidates = [cleaned, response.trim()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && parsed.priority) {
        return extractResult(parsed);
      }
    } catch {
      // Try next candidate
    }
  }

  // Fallback: find the first balanced JSON object containing "priority"
  const startIdx = response.indexOf('{');
  if (startIdx !== -1) {
    // Find matching closing brace by counting braces
    let depth = 0;
    for (let i = startIdx; i < response.length; i++) {
      if (response[i] === '{') { depth++; }
      else if (response[i] === '}') { depth--; }
      if (depth === 0) {
        const jsonStr = response.substring(startIdx, i + 1);
        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed && parsed.priority) {
            return extractResult(parsed);
          }
        } catch {
          // Continue looking
        }
        break;
      }
    }
  }

  // Last resort: try to determine priority from text
  const isHighPrio = /HIGH_PRIO|definite bug|security vulnerability|undefined behavior|must be fixed/i.test(response);
  const isFalsePositive = /FALSE_POSITIVE|false positive|not applicable|checker.*wrong|lack.*context/i.test(response);

  return {
    priority: isHighPrio ? 'HIGH_PRIO' : isFalsePositive ? 'FALSE_POSITIVE' : 'LOW_PRIO',
    comment: response.trim().substring(0, 2000),
  };
}

function extractResult(parsed: Record<string, unknown>): AnalysisResult {
  const priority = parsed.priority === 'HIGH_PRIO' ? 'HIGH_PRIO'
    : parsed.priority === 'FALSE_POSITIVE' ? 'FALSE_POSITIVE'
    : 'LOW_PRIO';
  const comment = String(parsed.comment || '').replace(/\\n/g, '\n');

  const result: AnalysisResult = { priority, comment };

  if (parsed.fixOldCode && parsed.fixNewCode) {
    result.fixOldCode = String(parsed.fixOldCode);
    result.fixNewCode = String(parsed.fixNewCode);
  }

  return result;
}

const CHALLENGER_PROMPT = `You are a senior code safety reviewer. Your SOLE JOB is to find reasons why a static analysis warning should NOT be dismissed.

A previous analysis concluded that the following warning is non-critical. Your task is to CHALLENGE that conclusion.

Specifically:
1. List every possible scenario where this code could fail, crash, produce wrong results, or cause undefined behavior.
2. For each scenario, explain whether the code explicitly guards against it (with evidence from the provided code).
3. Consider: interrupt context, multi-core access, compiler reordering, boundary values, NULL/uninitialized state, type promotion issues, signed/unsigned mismatches, buffer sizes, stack overflow, hardware register volatility.
4. If the previous analysis made ANY assumptions that are not provable from the provided code alone, the warning should be upgraded to HIGH_PRIO.

Respond with ONLY a valid JSON object:
{
  "shouldUpgrade": true or false,
  "reason": "explanation of why the warning should or should not be upgraded",
  "fixOldCode": "exact original code to replace (only if shouldUpgrade is true)",
  "fixNewCode": "corrected code (only if shouldUpgrade is true)"
}

Set shouldUpgrade to true if you find ANY realistic risk that is not explicitly handled in the code.`;

/**
 * Challenge a non-HIGH analysis result with a second adversarial pass.
 * Returns an upgraded result if the challenger finds the initial analysis missed something.
 */
export async function challengeAnalysis(
  warning: WarningRow,
  codeContext: string,
  relatedDefinitions: string,
  initialResult: AnalysisResult,
  projectContext: ProjectContext,
  cancellationToken: vscode.CancellationToken
): Promise<AnalysisResult> {
  // Only challenge LOW_PRIO and FALSE_POSITIVE results
  if (initialResult.priority === 'HIGH_PRIO') {
    return initialResult;
  }

  const model = await getModel();

  // Build environment note for challenger context
  const envParts: string[] = [];
  if (projectContext.targetPlatform) { envParts.push(`Target Platform: ${projectContext.targetPlatform}`); }
  if (projectContext.compiler) { envParts.push(`Compiler: ${projectContext.compiler}`); }
  if (projectContext.rtos) { envParts.push(`RTOS/OS: ${projectContext.rtos}`); }
  if (projectContext.safetyStandard) { envParts.push(`Safety Standard: ${projectContext.safetyStandard}`); }
  const envNote = envParts.length > 0 ? '\n' + envParts.map(p => `**${p}**`).join('\n') : '';

  const challengeContext = `**Warning:** ${warning.message}
**File:** ${warning.filePath}
**Line:** ${warning.lineInCode}
**Code:** \`${warning.codeLine}\`${envNote}

**Surrounding Code Context:**
\`\`\`c
${codeContext}
\`\`\`${relatedDefinitions ? `

**Related Definitions:**
\`\`\`c
${relatedDefinitions}
\`\`\`` : ''}

**Previous Analysis Conclusion:** ${initialResult.priority}
**Previous Analysis Reasoning:**
${initialResult.comment}

Now challenge this conclusion. Find reasons why this warning should be HIGH_PRIO instead.`;

  const messages = [
    vscode.LanguageModelChatMessage.User(CHALLENGER_PROMPT),
    vscode.LanguageModelChatMessage.User(challengeContext),
  ];

  try {
    const response = await model.sendRequest(
      messages,
      { justification: 'Challenger verification of CERT-C analysis' },
      cancellationToken
    );

    let fullResponse = '';
    for await (const fragment of response.text) {
      fullResponse += fragment;
    }

    if (!fullResponse.trim()) {
      return initialResult; // Keep original if challenger fails
    }

    // Parse challenger response — strip fences and find balanced JSON
    let challengerJson: Record<string, unknown> | null = null;
    let challengeCleaned = fullResponse.trim();
    const challengeFence = challengeCleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (challengeFence) {
      challengeCleaned = challengeFence[1].trim();
    }
    try { challengerJson = JSON.parse(challengeCleaned); } catch {}
    if (!challengerJson) {
      const idx = fullResponse.indexOf('{');
      if (idx !== -1) {
        let depth = 0;
        for (let i = idx; i < fullResponse.length; i++) {
          if (fullResponse[i] === '{') { depth++; }
          else if (fullResponse[i] === '}') { depth--; }
          if (depth === 0) {
            try { challengerJson = JSON.parse(fullResponse.substring(idx, i + 1)); } catch {}
            break;
          }
        }
      }
    }
    if (challengerJson) {
      try {
        const parsed = challengerJson;
        if (parsed.shouldUpgrade === true) {
          // Upgrade to HIGH_PRIO with combined analysis
          const upgradedComment = initialResult.comment +
            '\n\n--- Verification Review ---\n' +
            String(parsed.reason || 'Upgraded after adversarial review.');

          const result: AnalysisResult = {
            priority: 'HIGH_PRIO',
            comment: upgradedComment,
          };

          if (parsed.fixOldCode && parsed.fixNewCode) {
            result.fixOldCode = String(parsed.fixOldCode);
            result.fixNewCode = String(parsed.fixNewCode);
          }

          return result;
        }
      } catch {
        // JSON parse failed, keep original
      }
    }

    return initialResult;
  } catch {
    // If challenger fails for any reason, keep the original result
    return initialResult;
  }
}

/**
 * Estimate tokens for a batch of warnings.
 * Returns average tokens per warning and total estimated tokens.
 */
export async function estimateTokens(warningCount: number): Promise<{ perWarning: number; total: number; modelMax: number } | null> {
  try {
    const model = await getModel();
    // Estimate: system prompt + average user prompt (~1500 chars for context)
    const emptyCtx: ProjectContext = { targetPlatform: '', compiler: '', rtos: '', safetyStandard: '', projectNotes: '' };
    const samplePrompt = getSystemPrompt(emptyCtx) + '\n' + 'A'.repeat(1500);
    const tokensPerWarning = await model.countTokens(samplePrompt);
    // Add ~500 tokens for output per warning
    const totalInput = tokensPerWarning * warningCount;
    const totalOutput = 500 * warningCount;
    return {
      perWarning: tokensPerWarning + 500,
      total: totalInput + totalOutput,
      modelMax: model.maxInputTokens,
    };
  } catch {
    return null;
  }
}

export function resetModelCache(): void {
  cachedModel = null;
}
