/**
 * Musician Assistant Web UI
 * Handles UI interactions and API calls for the musician assistant features.
 */

// =============================================================================
// Tab Navigation
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
  initializeTabs();
  initializeForms();
  initializeFileUpload();
});

/**
 * Initialize tab navigation.
 */
function initializeTabs() {
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const targetTab = button.dataset.tab;

      // Update active states
      tabButtons.forEach(btn => btn.classList.remove('active'));
      tabPanes.forEach(pane => pane.classList.remove('active'));

      button.classList.add('active');
      document.getElementById(`${targetTab}-tab`).classList.add('active');
    });
  });
}

// =============================================================================
// Form Handlers
// =============================================================================

/**
 * Initialize all form handlers.
 */
function initializeForms() {
  document.getElementById('theory-form').addEventListener('submit', handleTheorySubmit);
  document.getElementById('composition-form').addEventListener('submit', handleCompositionSubmit);
  document.getElementById('audio-form').addEventListener('submit', handleAudioSubmit);
  document.getElementById('generation-form').addEventListener('submit', handleGenerationSubmit);
  document.getElementById('practice-form').addEventListener('submit', handlePracticeSubmit);
}

/**
 * Initialize file upload UI updates.
 */
function initializeFileUpload() {
  const fileInput = document.getElementById('audio-file');
  const fileNameDisplay = document.getElementById('audio-file-name');

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      fileNameDisplay.textContent = `Selected: ${file.name}`;
    } else {
      fileNameDisplay.textContent = '';
    }
  });
}

// =============================================================================
// Theory Tutor
// =============================================================================

async function handleTheorySubmit(e) {
  e.preventDefault();

  const form = e.target;
  const resultDiv = document.getElementById('theory-result');
  const submitBtn = form.querySelector('button[type="submit"]');

  // Collect form data
  const request = {
    topic: document.getElementById('theory-topic').value,
    skillLevel: document.getElementById('theory-skill').value,
    instrument: document.getElementById('theory-instrument').value || undefined,
    style: document.getElementById('theory-style').value || undefined,
    includeExercises: document.getElementById('theory-exercises').checked,
    includeExamples: document.getElementById('theory-examples').checked,
  };

  try {
    setLoadingState(submitBtn, true);
    hideError();
    resultDiv.style.display = 'none';

    const response = await fetch('/api/musician/theory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to generate theory explanation');
    }

    const result = await response.json();
    displayResult(resultDiv, result, 'Theory Explanation');
  } catch (error) {
    showError(error.message);
  } finally {
    setLoadingState(submitBtn, false);
  }
}

// =============================================================================
// Composition Assistant
// =============================================================================

async function handleCompositionSubmit(e) {
  e.preventDefault();

  const form = e.target;
  const resultDiv = document.getElementById('composition-result');
  const submitBtn = form.querySelector('button[type="submit"]');

  // Collect form data
  const request = {
    goal: document.getElementById('comp-goal').value,
    genre: document.getElementById('comp-genre').value || undefined,
    mood: document.getElementById('comp-mood').value || undefined,
    key: document.getElementById('comp-key').value || undefined,
    tempo: parseInt(document.getElementById('comp-tempo').value) || undefined,
    outputFormat: document.getElementById('comp-output').value,
  };

  try {
    setLoadingState(submitBtn, true);
    hideError();
    resultDiv.style.display = 'none';

    const response = await fetch('/api/musician/composition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to generate composition plan');
    }

    const result = await response.json();
    displayResult(resultDiv, result, 'Composition Plan');
  } catch (error) {
    showError(error.message);
  } finally {
    setLoadingState(submitBtn, false);
  }
}

// =============================================================================
// Audio Feedback
// =============================================================================

async function handleAudioSubmit(e) {
  e.preventDefault();

  const form = e.target;
  const resultDiv = document.getElementById('audio-result');
  const submitBtn = form.querySelector('button[type="submit"]');

  const fileInput = document.getElementById('audio-file');
  const file = fileInput.files[0];

  if (!file) {
    showError('Please select an audio file');
    return;
  }

  try {
    setLoadingState(submitBtn, true);
    hideError();
    resultDiv.style.display = 'none';

    // Step 1: Upload the file
    const formData = new FormData();
    formData.append('audio', file);

    const uploadResponse = await fetch('/api/musician/upload', {
      method: 'POST',
      body: formData,
    });

    if (!uploadResponse.ok) {
      const error = await uploadResponse.json();
      throw new Error(error.error || 'Failed to upload audio file');
    }

    const uploadResult = await uploadResponse.json();
    const fileId = uploadResult.asset.id;

    // Step 2: Run analysis
    const analysisRequest = {
      fileId,
      analysisType: document.getElementById('audio-analysis-type').value,
      genre: document.getElementById('audio-genre').value || undefined,
      userQuestions: document.getElementById('audio-notes').value
        ? [document.getElementById('audio-notes').value]
        : undefined,
      includeTechnicalMetrics: true,
      includeActionPlan: true,
    };

    const analysisResponse = await fetch('/api/musician/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(analysisRequest),
    });

    if (!analysisResponse.ok) {
      const error = await analysisResponse.json();
      throw new Error(error.error || 'Failed to analyze audio');
    }

    const analysisResult = await analysisResponse.json();
    displayAudioAnalysisResult(resultDiv, analysisResult);
  } catch (error) {
    showError(error.message);
  } finally {
    setLoadingState(submitBtn, false);
  }
}

/**
 * Display audio analysis results.
 */
function displayAudioAnalysisResult(container, result) {
  container.innerHTML = '';
  container.style.display = 'block';

  // Title
  const title = document.createElement('h3');
  title.className = 'result-title';
  title.textContent = 'Analysis Results';
  container.appendChild(title);

  // Warnings
  if (result.warnings && result.warnings.length > 0) {
    const warningsDiv = document.createElement('div');
    warningsDiv.className = 'warnings';
    warningsDiv.innerHTML = '<strong>⚠️ Warnings:</strong><ul>' +
      result.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('') +
      '</ul>';
    container.appendChild(warningsDiv);
  }

  // Confidence
  if (result.confidence !== undefined) {
    const confidenceDiv = document.createElement('div');
    confidenceDiv.className = 'confidence';
    const confidencePercent = Math.round(result.confidence * 100);
    confidenceDiv.innerHTML = `<strong>Confidence:</strong> ${confidencePercent}%`;
    container.appendChild(confidenceDiv);
  }

  // Technical Metrics
  if (result.metrics) {
    const metricsDiv = document.createElement('div');
    metricsDiv.className = 'metrics-section';
    metricsDiv.innerHTML = '<h4>Technical Metrics</h4>' + formatMetrics(result.metrics);
    container.appendChild(metricsDiv);
  }

  // Report
  if (result.report) {
    const reportDiv = document.createElement('div');
    reportDiv.className = 'report-section';
    reportDiv.innerHTML = '<h4>Feedback Report</h4>';

    if (typeof result.report === 'string') {
      reportDiv.innerHTML += formatMarkdown(result.report);
    } else {
      reportDiv.innerHTML += formatStructuredReport(result.report);
    }

    container.appendChild(reportDiv);
  }
}

/**
 * Format technical metrics for display.
 */
function formatMetrics(metrics) {
  const items = [];

  if (metrics.durationSeconds !== undefined) {
    items.push(`Duration: ${metrics.durationSeconds.toFixed(1)}s`);
  }
  if (metrics.sampleRate !== undefined) {
    items.push(`Sample Rate: ${metrics.sampleRate} Hz`);
  }
  if (metrics.channels !== undefined) {
    items.push(`Channels: ${metrics.channels === 1 ? 'Mono' : 'Stereo'}`);
  }
  if (metrics.integratedLufs !== undefined) {
    items.push(`Loudness: ${metrics.integratedLufs.toFixed(1)} LUFS`);
  }
  if (metrics.truePeakDbtp !== undefined) {
    items.push(`True Peak: ${metrics.truePeakDbtp.toFixed(1)} dBTP`);
  }
  if (metrics.tempoBpm !== undefined) {
    items.push(`Tempo: ${metrics.tempoBpm.toFixed(0)} BPM`);
  }
  if (metrics.keyEstimate) {
    items.push(`Key: ${metrics.keyEstimate}`);
  }

  return '<ul>' + items.map(item => `<li>${escapeHtml(item)}</li>`).join('') + '</ul>';
}

/**
 * Format structured report (MixFeedbackReport or MasteringFeedbackReport).
 */
function formatStructuredReport(report) {
  let html = '';

  if (report.summary) {
    html += `<p><strong>Summary:</strong> ${escapeHtml(report.summary)}</p>`;
  }

  if (report.strengths && report.strengths.length > 0) {
    html += '<p><strong>✅ Strengths:</strong></p><ul>' +
      report.strengths.map(s => `<li>${escapeHtml(s)}</li>`).join('') +
      '</ul>';
  }

  if (report.issues && report.issues.length > 0) {
    html += '<p><strong>⚠️ Issues:</strong></p><ul>' +
      report.issues.map(i => `<li>${escapeHtml(i)}</li>`).join('') +
      '</ul>';
  }

  if (report.releaseReadiness) {
    html += `<p><strong>Release Readiness:</strong> ${escapeHtml(report.releaseReadiness)}</p>`;
  }

  return html;
}

// =============================================================================
// Text-to-Music Generation
// =============================================================================

async function handleGenerationSubmit(e) {
  e.preventDefault();

  const form = e.target;
  const resultDiv = document.getElementById('generation-result');
  const submitBtn = form.querySelector('button[type="submit"]');

  // Collect form data
  const request = {
    prompt: document.getElementById('gen-prompt').value,
    durationSeconds: parseInt(document.getElementById('gen-duration').value),
    tempo: parseInt(document.getElementById('gen-tempo').value) || undefined,
    key: document.getElementById('gen-key').value || undefined,
    genre: document.getElementById('gen-genre').value || undefined,
    dryRun: document.getElementById('gen-dryrun').checked,
  };

  try {
    setLoadingState(submitBtn, true);
    hideError();
    resultDiv.style.display = 'none';

    const response = await fetch('/api/musician/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to generate music');
    }

    const result = await response.json();
    displayGenerationResult(resultDiv, result);
  } catch (error) {
    showError(error.message);
  } finally {
    setLoadingState(submitBtn, false);
  }
}

/**
 * Display music generation results.
 */
function displayGenerationResult(container, result) {
  container.innerHTML = '';
  container.style.display = 'block';

  const title = document.createElement('h3');
  title.className = 'result-title';
  title.textContent = 'Generation Results';
  container.appendChild(title);

  // Warnings
  if (result.warnings && result.warnings.length > 0) {
    const warningsDiv = document.createElement('div');
    warningsDiv.className = 'warnings';
    warningsDiv.innerHTML = '<strong>⚠️ Warnings:</strong><ul>' +
      result.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('') +
      '</ul>';
    container.appendChild(warningsDiv);
  }

  // Generation info
  const infoDiv = document.createElement('div');
  infoDiv.className = 'generation-info';
  infoDiv.innerHTML = `
    <p><strong>Asset ID:</strong> ${escapeHtml(result.assetId)}</p>
    <p><strong>Model:</strong> ${escapeHtml(result.model)}</p>
    <p><strong>Duration:</strong> ${result.durationSeconds}s</p>
    <p><strong>Prompt:</strong> ${escapeHtml(result.prompt)}</p>
  `;

  if (result.filePath && !result.filePath.includes('metadata.json')) {
    infoDiv.innerHTML += `<p><strong>File:</strong> ${escapeHtml(result.filePath)}</p>`;
  }

  container.appendChild(infoDiv);
}

// =============================================================================
// Practice Plan
// =============================================================================

async function handlePracticeSubmit(e) {
  e.preventDefault();

  const form = e.target;
  const resultDiv = document.getElementById('practice-result');
  const submitBtn = form.querySelector('button[type="submit"]');

  // Collect form data
  const request = {
    instrument: document.getElementById('practice-instrument').value,
    goal: document.getElementById('practice-goal').value,
    minutesPerDay: parseInt(document.getElementById('practice-minutes').value),
    daysPerWeek: parseInt(document.getElementById('practice-days').value),
    skillLevel: document.getElementById('practice-level').value,
  };

  try {
    setLoadingState(submitBtn, true);
    hideError();
    resultDiv.style.display = 'none';

    const response = await fetch('/api/musician/practice-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to generate practice plan');
    }

    const result = await response.json();
    displayResult(resultDiv, result, 'Practice Plan');
  } catch (error) {
    showError(error.message);
  } finally {
    setLoadingState(submitBtn, false);
  }
}

// =============================================================================
// UI Utilities
// =============================================================================

/**
 * Display a generic result.
 */
function displayResult(container, result, title) {
  container.innerHTML = '';
  container.style.display = 'block';

  const titleEl = document.createElement('h3');
  titleEl.className = 'result-title';
  titleEl.textContent = title;
  container.appendChild(titleEl);

  const contentDiv = document.createElement('div');
  contentDiv.className = 'result-content';

  if (typeof result === 'string') {
    contentDiv.innerHTML = formatMarkdown(result);
  } else if (result.content) {
    contentDiv.innerHTML = formatMarkdown(result.content);
  } else {
    contentDiv.innerHTML = '<pre>' + escapeHtml(JSON.stringify(result, null, 2)) + '</pre>';
  }

  container.appendChild(contentDiv);
}

/**
 * Basic markdown formatting.
 */
function formatMarkdown(text) {
  let html = escapeHtml(text);

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^## (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^# (.+)$/gm, '<h3>$1</h3>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

  // Line breaks
  html = html.replace(/\n\n/g, '</p><p>');
  html = '<p>' + html + '</p>';

  return html;
}

/**
 * Set loading state on a button.
 */
function setLoadingState(button, loading) {
  const textSpan = button.querySelector('.btn-text');
  const loadingSpan = button.querySelector('.btn-loading');

  if (loading) {
    button.disabled = true;
    textSpan.style.display = 'none';
    loadingSpan.style.display = 'inline';
  } else {
    button.disabled = false;
    textSpan.style.display = 'inline';
    loadingSpan.style.display = 'none';
  }
}

/**
 * Show error message.
 */
function showError(message) {
  const banner = document.getElementById('error-banner');
  banner.textContent = '❌ ' + message;
  banner.style.display = 'block';
  setTimeout(() => {
    banner.style.display = 'none';
  }, 5000);
}

/**
 * Hide error message.
 */
function hideError() {
  const banner = document.getElementById('error-banner');
  banner.style.display = 'none';
}

/**
 * Escape HTML to prevent XSS.
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
