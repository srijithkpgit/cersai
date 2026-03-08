(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // State
  let excelPath = '';
  let folderPath = '';

  // Elements
  const excelPathEl = document.getElementById('excelPath');
  const folderPathEl = document.getElementById('folderPath');
  const btnSelectExcel = document.getElementById('btnSelectExcel');
  const btnSelectFolder = document.getElementById('btnSelectFolder');
  const btnStart = document.getElementById('btnStart');
  const btnCancel = document.getElementById('btnCancel');
  const progressSection = document.getElementById('progressSection');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  const summarySection = document.getElementById('summarySection');
  const logContainer = document.getElementById('logContainer');
  const defensivenessSlider = document.getElementById('defensivenessSlider');
  const autoFixCheckbox = document.getElementById('autoFixCheckbox');
  const skipAnalyzedCheckbox = document.getElementById('skipAnalyzedCheckbox');
  const manualSelectCheckbox = document.getElementById('manualSelectCheckbox');
  const reviewFixesCheckbox = document.getElementById('reviewFixesCheckbox');
  const reviewFixesLabel = document.getElementById('reviewFixesLabel');
  const targetPlatformInput = document.getElementById('targetPlatformInput');
  const compilerInput = document.getElementById('compilerInput');
  const rtosInput = document.getElementById('rtosInput');
  const safetyStandardInput = document.getElementById('safetyStandardInput');
  const projectNotesInput = document.getElementById('projectNotesInput');
  const exportSection = document.getElementById('exportSection');
  const btnExport = document.getElementById('btnExport');

  // Show/hide review fixes sub-option based on auto-fix checkbox
  autoFixCheckbox.addEventListener('change', () => {
    reviewFixesLabel.style.display = autoFixCheckbox.checked ? 'flex' : 'none';
  });

  // Button handlers
  btnSelectExcel.addEventListener('click', () => {
    vscode.postMessage({ command: 'selectExcel' });
  });

  btnSelectFolder.addEventListener('click', () => {
    vscode.postMessage({ command: 'selectFolder' });
  });

  btnStart.addEventListener('click', () => {
    const levels = { '1': 'relaxed', '2': 'neutral', '3': 'strict' };
    vscode.postMessage({
      command: 'startAnalysis',
      excelPath: excelPath,
      projectFolder: folderPath,
      defensiveness: levels[defensivenessSlider.value] || 'neutral',
      targetPlatform: targetPlatformInput.value.trim(),
      compiler: compilerInput.value.trim(),
      rtos: rtosInput.value.trim(),
      safetyStandard: safetyStandardInput.value.trim(),
      projectNotes: projectNotesInput.value.trim(),
      autoFix: autoFixCheckbox.checked,
      skipAnalyzed: skipAnalyzedCheckbox.checked,
      manualSelect: manualSelectCheckbox.checked,
      reviewFixes: reviewFixesCheckbox.checked,
    });
  });

  btnCancel.addEventListener('click', () => {
    vscode.postMessage({ command: 'cancelAnalysis' });
  });

  btnExport.addEventListener('click', () => {
    vscode.postMessage({ command: 'exportReport' });
  });

  // Ensure clean initial state on load
  function resetToInitialState() {
    btnStart.style.display = 'block';
    btnStart.disabled = true;
    btnStart.textContent = 'Start Analysis';
    btnCancel.style.display = 'none';
    btnCancel.disabled = false;
    btnSelectExcel.disabled = false;
    btnSelectFolder.disabled = false;
    progressSection.style.display = 'none';
    summarySection.style.display = 'none';
    logContainer.innerHTML = '';
  }
  resetToInitialState();

  function updateStartButton() {
    btnStart.disabled = !(excelPath && folderPath);
  }

  function addLogEntry(badge, badgeClass, message, rowNum, filePath, lineInCode) {
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    if (filePath) {
      entry.classList.add('clickable');
      entry.title = filePath + ':' + lineInCode;
      entry.addEventListener('click', () => {
        vscode.postMessage({ command: 'openFile', filePath: filePath, line: lineInCode });
      });
    }

    const badgeEl = document.createElement('span');
    badgeEl.className = 'badge ' + badgeClass;
    badgeEl.textContent = badge;

    const rowEl = document.createElement('span');
    rowEl.className = 'log-row-num';
    rowEl.textContent = 'Row ' + rowNum;

    const msgEl = document.createElement('span');
    msgEl.className = 'log-message';
    msgEl.textContent = message;

    entry.appendChild(badgeEl);
    entry.appendChild(rowEl);
    entry.appendChild(msgEl);
    logContainer.appendChild(entry);

    // Auto-scroll to bottom
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  function truncate(str, maxLen) {
    return str.length > maxLen ? str.substring(0, maxLen - 3) + '...' : str;
  }

  function getFileName(filePath) {
    return filePath.split(/[/\\]/).pop() || filePath;
  }

  // Message handler
  window.addEventListener('message', (event) => {
    const msg = event.data;

    switch (msg.command) {
      case 'excelSelected':
        excelPath = msg.path;
        excelPathEl.textContent = getFileName(msg.path);
        excelPathEl.title = msg.path;
        excelPathEl.classList.add('selected');
        updateStartButton();
        break;

      case 'folderSelected':
        folderPath = msg.path;
        folderPathEl.textContent = getFileName(msg.path);
        folderPathEl.title = msg.path;
        folderPathEl.classList.add('selected');
        updateStartButton();
        break;

      case 'statusWarning':
        addLogEntry('WARN', 'error', msg.message, '-');
        break;

      case 'statusOk':
        addLogEntry('OK', 'low', msg.message, '-');
        break;

      case 'validating':
        btnStart.disabled = true;
        btnStart.textContent = msg.message || 'Validating...';
        progressSection.style.display = 'none';
        break;

      case 'tokenEstimate': {
        const totalK = Math.round(msg.total / 1000);
        addLogEntry('INFO', 'low', `~${totalK}k tokens for ${msg.warningCount} warnings (~${msg.perWarning} per warning)`, '-');
        break;
      }

      case 'validationError':
        btnStart.disabled = false;
        btnStart.textContent = 'Start Analysis';
        addLogEntry('ERR', 'error', msg.error, '-');
        break;

      case 'analysisStarted':
        btnStart.style.display = 'none';
        btnStart.textContent = 'Start Analysis';
        btnCancel.style.display = 'block';
        btnSelectExcel.disabled = true;
        btnSelectFolder.disabled = true;
        defensivenessSlider.disabled = true;
        targetPlatformInput.disabled = true;
        compilerInput.disabled = true;
        rtosInput.disabled = true;
        safetyStandardInput.disabled = true;
        projectNotesInput.disabled = true;
        autoFixCheckbox.disabled = true;
        skipAnalyzedCheckbox.disabled = true;
        manualSelectCheckbox.disabled = true;
        reviewFixesCheckbox.disabled = true;

        exportSection.style.display = 'none';
        progressSection.style.display = 'flex';
        progressBar.style.width = '0%';
        progressText.textContent = 'Starting analysis of ' + (msg.warningCount || '?') + ' warnings...';
        summarySection.style.display = 'none';
        logContainer.innerHTML = '';
        break;

      case 'progress':
        const pct = Math.round((msg.current / msg.total) * 100);
        progressBar.style.width = pct + '%';
        progressText.textContent = msg.current + '/' + msg.total + ' - ' + msg.message;
        break;

      case 'result':
        if (msg.error) {
          addLogEntry('ERR', 'error', msg.error, msg.rowNumber, msg.filePath, msg.lineInCode);
        } else {
          let badge, badgeClass;
          if (msg.priority === 'HIGH_PRIO') {
            badge = msg.fixApplied ? 'FIXED' : 'HIGH';
            badgeClass = msg.fixApplied ? 'fixed' : 'high';
          } else if (msg.priority === 'FALSE_POSITIVE') {
            badge = 'FP';
            badgeClass = 'fp';
          } else {
            badge = 'LOW';
            badgeClass = 'low';
          }
          addLogEntry(badge, badgeClass, truncate(msg.comment || '', 100), msg.rowNumber, msg.filePath, msg.lineInCode);
        }
        break;

      case 'analysisCancelling':
        progressText.textContent = 'Cancelling...';
        btnCancel.disabled = true;
        break;

      case 'analysisComplete':
        btnStart.style.display = 'block';
        btnCancel.style.display = 'none';
        btnCancel.disabled = false;
        btnSelectExcel.disabled = false;
        btnSelectFolder.disabled = false;
        defensivenessSlider.disabled = false;
        targetPlatformInput.disabled = false;
        compilerInput.disabled = false;
        rtosInput.disabled = false;
        safetyStandardInput.disabled = false;
        projectNotesInput.disabled = false;
        autoFixCheckbox.disabled = false;
        skipAnalyzedCheckbox.disabled = false;
        manualSelectCheckbox.disabled = false;
        reviewFixesCheckbox.disabled = false;

        progressBar.style.width = '100%';
        progressText.textContent = msg.summary.cancelled
          ? 'Cancelled after ' + msg.summary.analyzed + '/' + msg.summary.total
          : 'Complete!';

        // Show summary
        summarySection.style.display = 'block';
        document.getElementById('summaryTotal').textContent = msg.summary.total;
        document.getElementById('summaryAnalyzed').textContent = msg.summary.analyzed;
        document.getElementById('summaryHigh').textContent = msg.summary.highPrio;
        document.getElementById('summaryLow').textContent = msg.summary.lowPrio;
        document.getElementById('summaryFP').textContent = msg.summary.falsePositive;
        document.getElementById('summaryFixed').textContent = msg.summary.fixed;
        document.getElementById('summaryUpgraded').textContent = msg.summary.upgraded;
        document.getElementById('summaryErrors').textContent = msg.summary.errors;
        exportSection.style.display = 'block';
        break;

      case 'analysisError':
        btnStart.style.display = 'block';
        btnCancel.style.display = 'none';
        btnCancel.disabled = false;
        btnSelectExcel.disabled = false;
        btnSelectFolder.disabled = false;
        defensivenessSlider.disabled = false;
        targetPlatformInput.disabled = false;
        compilerInput.disabled = false;
        rtosInput.disabled = false;
        safetyStandardInput.disabled = false;
        projectNotesInput.disabled = false;
        autoFixCheckbox.disabled = false;
        skipAnalyzedCheckbox.disabled = false;
        manualSelectCheckbox.disabled = false;
        reviewFixesCheckbox.disabled = false;

        progressText.textContent = 'Error: ' + msg.error;
        break;

      case 'configLoaded':
        if (msg.config) {
          const c = msg.config;
          if (c.excelPath) {
            excelPath = c.excelPath;
            excelPathEl.textContent = getFileName(c.excelPath);
            excelPathEl.title = c.excelPath;
            excelPathEl.classList.add('selected');
          }
          if (c.projectFolder) {
            folderPath = c.projectFolder;
            folderPathEl.textContent = getFileName(c.projectFolder);
            folderPathEl.title = c.projectFolder;
            folderPathEl.classList.add('selected');
          }
          if (c.defensiveness) {
            const levelMap = { 'relaxed': '1', 'neutral': '2', 'strict': '3' };
            defensivenessSlider.value = levelMap[c.defensiveness] || '2';
          }
          if (c.autoFix !== undefined) {
            autoFixCheckbox.checked = c.autoFix;
            reviewFixesLabel.style.display = c.autoFix ? 'flex' : 'none';
          }
          if (c.targetPlatform !== undefined) { targetPlatformInput.value = c.targetPlatform; }
          if (c.compiler !== undefined) { compilerInput.value = c.compiler; }
          if (c.rtos !== undefined) { rtosInput.value = c.rtos; }
          if (c.safetyStandard !== undefined) { safetyStandardInput.value = c.safetyStandard; }
          if (c.projectNotes !== undefined) { projectNotesInput.value = c.projectNotes; }
          if (c.reviewFixes !== undefined) { reviewFixesCheckbox.checked = c.reviewFixes; }
          if (c.skipAnalyzed !== undefined) { skipAnalyzedCheckbox.checked = c.skipAnalyzed; }
          updateStartButton();
        }
        break;

      case 'triggerStart':
        if (excelPath && folderPath) {
          const triggerLevels = { '1': 'relaxed', '2': 'neutral', '3': 'strict' };
          vscode.postMessage({
            command: 'startAnalysis',
            excelPath: excelPath,
            projectFolder: folderPath,
            defensiveness: triggerLevels[defensivenessSlider.value] || 'neutral',
            targetPlatform: targetPlatformInput.value.trim(),
            compiler: compilerInput.value.trim(),
            rtos: rtosInput.value.trim(),
            safetyStandard: safetyStandardInput.value.trim(),
            projectNotes: projectNotesInput.value.trim(),
            autoFix: autoFixCheckbox.checked,
            skipAnalyzed: skipAnalyzedCheckbox.checked,
            manualSelect: manualSelectCheckbox.checked,
            reviewFixes: reviewFixesCheckbox.checked,
          });
        }
        break;
    }
  });
})();
