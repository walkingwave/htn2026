import { DIFFICULTIES, DRILLS } from './session.js';
import { getLeaderboard, submitScore, scoreFor } from './leaderboard.js';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function createTrainerUI({ onStart, onPause, onReset, onMachineToggle, onEnableCV }) {
  const root = document.createElement('section');
  root.className = 'trainer-ui';
  root.innerHTML = `<header class="topbar"><div class="brand"><span class="brand-mark">✦</span><span>flyball<span class="accent">.</span></span></div><div class="session-pill"><span class="live-dot"></span><span id="session-status">READY</span></div><button class="text-button" id="leaderboard-button">Leaderboard ↗</button></header>
  <div class="hud-grid"><div class="hud-card score-card"><span class="eyebrow">YOUR SCORE</span><strong id="score">0</strong><small><span id="rally">0</span> hit rally</small></div><div class="hud-card"><span class="eyebrow">BEST RALLY</span><strong id="best-rally">0</strong><small>clean returns</small></div><div class="hud-card"><span class="eyebrow">DRILL PROGRESS</span><strong id="accuracy">—</strong><small id="progress-label">returns / attempts</small></div><div class="hud-card boss-card"><span class="eyebrow">BOSS LEVEL</span><strong id="boss-level">01</strong><small id="difficulty-label">Standard drill</small></div></div>
  <div class="feedback" id="feedback">Choose a drill to begin.</div>
  <aside class="control-panel"><div><span class="eyebrow">COACHING PLAN</span><h1 id="panel-title">Build your fundamentals.</h1><p id="panel-copy">Pick a drill, then use your paddle to return the simulated ball.</p></div><div class="target-stage" id="target-stage"><div><span class="eyebrow">CURRENT MOVE</span><strong id="target-move">Ready to train</strong></div><span class="target-count" id="target-count">0 / 5</span><p id="target-cue">Every target move requires five clean repetitions before the next one unlocks.</p></div><div class="drill-list">${Object.entries(DRILLS).map(([key, value]) => `<button class="drill-option ${key === 'rally' ? 'selected' : ''}" data-drill="${key}"><span class="difficulty-icon">${key === 'fly' ? '✦' : key === 'target' ? '◎' : '↗'}</span><span><b>${value.label}</b><small>${value.detail}</small></span></button>`).join('')}</div><div class="difficulty-list">${Object.entries(DIFFICULTIES).map(([key, value]) => `<button class="difficulty-option ${key === 'standard' ? 'selected' : ''}" data-difficulty="${key}"><span><b>${value.label}</b><small>${value.detail}</small></span></button>`).join('')}</div><div class="control-actions"><button class="primary-button" id="start-button">Start drill →</button><button class="secondary-button" id="pause-button">Pause</button><button class="secondary-button" id="reset-button">Reset</button></div><div class="control-actions secondary-actions"><button class="secondary-button" id="machine-button">Pause ball machine</button><button class="secondary-button" id="cv-button">Use camera paddle</button></div><p class="control-hint">No VR required: move the on-screen paddle with your pointer, or enable camera CV. XR remains available when you have it.</p></aside>
  <div class="leaderboard-panel hidden" id="leaderboard-panel"><div class="panel-heading"><div><span class="eyebrow">THE ARENA / LIVE RANKINGS</span><h2>Fundamentals under pressure.</h2></div><button class="text-button" id="close-leaderboard">Close</button></div><div class="leader-tabs"><button class="leader-tab selected" data-category="fundamentals">Fundamentals</button><button class="leader-tab" data-category="boss">Boss survival</button></div><div id="leaderboard-list"></div></div>
  <div class="summary-panel hidden" id="summary-panel"><span class="eyebrow">SESSION COMPLETE</span><h2 id="summary-title">Good work.</h2><p id="summary-coach" class="summary-coach"></p><div class="summary-grid" id="summary-grid"></div><div class="save-row"><input id="player-name" maxlength="32" placeholder="your name" aria-label="Player name"/><button class="primary-button" id="save-score">Save score</button></div><p class="save-status" id="save-status"></p><button class="secondary-button" id="summary-close">Back to drills</button></div>`;
  document.body.appendChild(root);

  let difficulty = 'standard';
  let drill = 'rally';
  let category = 'fundamentals';
  let lastSummary = null;
  const $ = (id) => root.querySelector(`#${id}`);

  const update = (summary, status = 'TRAINING') => {
    if (!summary) return;
    $('score').textContent = summary.score;
    $('rally').textContent = summary.rally;
    $('best-rally').textContent = summary.longestRally;
    $('accuracy').textContent = drill === 'target' ? `${summary.targetAccuracy}%` : `${summary.accuracy}%`;
    $('progress-label').textContent = drill === 'target'
      ? `${summary.completedMoves}/${summary.totalMoves} moves · ${summary.targetHits} hits`
      : 'returns / attempts';
    $('boss-level').textContent = String(summary.bossLevel).padStart(2, '0');
    $('difficulty-label').textContent = `${DRILLS[summary.drill].label} · ${DIFFICULTIES[summary.difficulty].label}`;
    $('session-status').textContent = status;
    $('target-stage').classList.toggle('active', drill === 'target');
    if (drill === 'target') {
      $('target-move').textContent = `${summary.currentMoveNumber}. ${summary.currentMoveLabel}`;
      $('target-count').textContent = `${summary.moveSuccesses} / ${summary.moveRequired}`;
      $('target-cue').textContent = summary.currentMoveCue;
    } else {
      $('target-move').textContent = 'Target sequence offline';
      $('target-count').textContent = '—';
      $('target-cue').textContent = DRILLS[drill].coach;
    }
  };

  const feedback = (message, kind = '') => {
    const node = $('feedback');
    node.textContent = message;
    node.className = `feedback ${kind}`;
    window.clearTimeout(feedback.timer);
    feedback.timer = window.setTimeout(() => node.className = 'feedback', 1800);
  };

  const showSummary = (summary) => {
    lastSummary = summary;
    update(summary, 'COMPLETE');
    $('summary-title').textContent = summary.drill === 'fly'
      ? 'You read the fly.'
      : summary.drill === 'target'
        ? (summary.targetComplete ? 'Target sequence complete.' : `${summary.completedMoves} moves completed.`)
        : 'You found your rhythm.';
    $('summary-coach').textContent = summary.drill === 'target'
      ? `${summary.completedMoves}/${summary.totalMoves} moves complete. ${summary.targetComplete ? 'Excellent control—repeat the sequence at the next speed.' : DRILLS.target.coach}`
      : summary.accuracy >= 70 ? 'Good consistency. Next, reduce swing size and challenge the next speed.' : DRILLS[summary.drill].coach;
    $('summary-grid').innerHTML = [
      ['Score', summary.score],
      ['Moves complete', `${summary.completedMoves}/${summary.totalMoves}`],
      ['Longest rally', `${summary.longestRally} hits`],
      ['Accuracy', `${summary.accuracy}%`],
      ['Target hits', `${summary.targetHits}`],
      ['Survival', `${summary.survivalSeconds}s`],
      ['Reaction', summary.reactionMs ? `${summary.reactionMs}ms` : '—'],
    ].map(([label, value]) => `<div><small>${label}</small><strong>${value}</strong></div>`).join('');
    $('summary-panel').classList.remove('hidden');
  };

  const loadLeaderboard = async () => {
    const list = $('leaderboard-list');
    list.innerHTML = '<p class="muted">Loading rankings…</p>';
    const rows = await getLeaderboard(category);
    list.innerHTML = rows.length ? rows.map((row, index) => `<div class="leader-row"><span class="rank">${String(index + 1).padStart(2, '0')}</span><span><b>${escapeHtml(row.player_name)}</b><small>${row.max_rally} hit rally · ${row.difficulty}</small></span><strong>${row.score.toLocaleString()} pts</strong></div>`).join('') : '<p class="muted">No scores yet. Be first.</p>';
  };

  root.querySelectorAll('[data-drill]').forEach((button) => button.addEventListener('click', () => {
    drill = button.dataset.drill;
    root.querySelectorAll('[data-drill]').forEach((item) => item.classList.toggle('selected', item === button));
    $('panel-title').textContent = DRILLS[drill].label;
    $('panel-copy').textContent = DRILLS[drill].detail;
    update({ ...({ drill, difficulty }), completedMoves: 0, totalMoves: 6, targetHits: 0, targetAccuracy: 0, accuracy: 0, score: 0, rally: 0, longestRally: 0, bossLevel: DIFFICULTIES[difficulty].bossLevel, currentMoveNumber: 1, currentMoveLabel: 'Ready to train', currentMoveCue: DRILLS[drill].coach, moveSuccesses: 0, moveRequired: 5 }, 'READY');
  }));
  root.querySelectorAll('[data-difficulty]').forEach((button) => button.addEventListener('click', () => {
    difficulty = button.dataset.difficulty;
    root.querySelectorAll('[data-difficulty]').forEach((item) => item.classList.toggle('selected', item === button));
  }));

  $('start-button').addEventListener('click', () => { $('summary-panel').classList.add('hidden'); onStart(difficulty, drill); feedback(drill === 'target' ? 'Move 1 live — land five clean shots.' : 'Rally live — watch the serve.', 'success'); });
  $('pause-button').addEventListener('click', () => onPause());
  $('reset-button').addEventListener('click', () => onReset());
  $('machine-button').addEventListener('click', () => { const enabled = onMachineToggle(); $('machine-button').textContent = enabled ? 'Pause ball machine' : 'Resume ball machine'; });
  $('cv-button').addEventListener('click', () => { onEnableCV(); $('cv-button').textContent = 'Camera loading…'; });
  $('leaderboard-button').addEventListener('click', () => { $('leaderboard-panel').classList.remove('hidden'); loadLeaderboard(); });
  $('close-leaderboard').addEventListener('click', () => $('leaderboard-panel').classList.add('hidden'));
  $('summary-close').addEventListener('click', () => $('summary-panel').classList.add('hidden'));
  root.querySelectorAll('.leader-tab').forEach((button) => button.addEventListener('click', () => { category = button.dataset.category; root.querySelectorAll('.leader-tab').forEach((item) => item.classList.toggle('selected', item === button)); loadLeaderboard(); }));
  $('save-score').addEventListener('click', async () => {
    const name = $('player-name').value.trim();
    if (!name || !lastSummary) { $('save-status').textContent = 'Add your name first.'; return; }
    $('save-status').textContent = 'Saving…';
    try {
      const result = await submitScore(name, lastSummary, category);
      $('save-status').textContent = result.persisted === false ? `Saved locally — configure Supabase to publish globally. (${scoreFor(lastSummary, category)} pts)` : 'Score saved to the arena.';
    } catch { $('save-status').textContent = 'Could not reach the leaderboard. Your session is still safe.'; }
  });

  return { update, feedback, showSummary, getDifficulty: () => difficulty, getDrill: () => drill };
}
