import { DIFFICULTIES, DRILLS } from './session.js';
import { getLeaderboard, submitScore, scoreFor } from './leaderboard.js';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function createTrainerUI({ onStart, onPause, onReset, onMachineToggle, onEnableCV, onDrillChange, onLandscapeChange }) {
  const root = document.createElement('section');
  root.className = 'trainer-ui landing-active';
  root.innerHTML = `<section class="landing-screen" id="landing-screen" aria-label="Flyball ping pong trainer introduction">
    <nav class="landing-nav"><a class="landing-brand" href="#top" aria-label="flyball home"><span class="brand-emoji" aria-hidden="true">🏓</span><span>flyball<span class="accent">.</span></span></a><div class="landing-nav-links"><a href="#how-it-works">How it works</a><a href="#drills">Drills</a><a href="#leaderboard-preview">Leaderboard</a></div><button class="landing-nav-cta" id="landing-nav-start">Start training <span>↗</span></button></nav>
    <div class="landing-hero" id="top"><div class="hero-copy"><div class="hero-kicker"><span class="hero-kicker-dot"></span> DESKTOP-FIRST PING PONG COACH</div><h1>Hone your skills.<br><em>Play to win.</em></h1><p class="hero-lede">Train every return, play against a fly that refuses to give you easy points, then step into Versus when you feel like a pro.</p><div class="hero-actions"><button class="landing-primary" id="landing-start">Start your first drill <span>→</span></button><button class="landing-ghost" id="landing-camera"><span class="camera-icon">◉</span> Play with your camera</button></div><div class="hero-note"><span>NO VR REQUIRED</span><span class="note-line"></span><span>POINTER · WEBCAM · XR</span></div></div><div class="hero-arena" aria-label="Player view across a ping pong table"><div class="hero-glow"></div><div class="hero-grid"></div><div class="hero-view-label"><span></span> PLAYER VIEW / POINT 08</div><div class="hero-table"><div class="hero-net"></div><div class="hero-target"></div><div class="hero-paddle hero-paddle-player"></div><div class="hero-paddle hero-paddle-fly"></div><div class="hero-ball"></div></div><div class="hero-fly"><span class="fly-eye fly-eye-left"></span><span class="fly-eye fly-eye-right"></span><span class="fly-wing fly-wing-left"></span><span class="fly-wing fly-wing-right"></span></div><div class="hero-stat hero-stat-one"><b>06</b><span>coaching moves</span></div><div class="hero-stat hero-stat-two"><b>05×</b><span>clean reps to advance</span></div><div class="hero-caption"><span class="caption-dot"></span> LIVE TRAINING SIMULATION</div></div></div>
    <div class="landing-strip" id="how-it-works"><div><span class="strip-number">01</span><strong>Hone it.</strong><small>Build the fundamentals that make every shot cleaner.</small></div><div><span class="strip-number">02</span><strong>Play the fly.</strong><small>Read a moving opponent and stay composed under pressure.</small></div><div><span class="strip-number">03</span><strong>Go Versus.</strong><small>Feeling like a pro? Crush others on the leaderboard.</small></div></div>
    <section class="landing-section" id="drills"><div class="section-heading"><div><span class="landing-eyebrow">YOUR TRAINING ROOM</span><h2>Every point has a purpose.</h2></div><p>Choose the skill you want to sharpen. The coach tracks the details that matter after the rally is over.</p></div><div class="landing-drill-grid"><button class="landing-drill-card landing-drill-target" data-landing-drill="target"><span class="drill-card-top"><span class="card-icon">◎</span><span class="card-arrow">↗</span></span><strong>Hone your skills</strong><p>Six progressive moves. Five successful shots per target. No skipping the fundamentals.</p><span class="card-meta">FOREHAND · BACKHAND · PLACEMENT</span></button><button class="landing-drill-card landing-drill-fly" data-landing-drill="fly"><span class="drill-card-top"><span class="card-icon">✦</span><span class="card-arrow">↗</span></span><strong>Play against a fly</strong><p>Read an opponent that moves, returns, and makes you earn every clean point.</p><span class="card-meta">REACTION · PRESSURE · SURVIVAL</span></button><button class="landing-drill-card landing-drill-rally" data-landing-drill="rally"><span class="drill-card-top"><span class="card-icon">↗</span><span class="card-arrow">↗</span></span><strong>Feeling like a pro?</strong><p>Crush others in Versus. First, build the consistency that makes a champion hard to beat.</p><span class="card-meta">TIMING · CONTROL · CONSISTENCY</span></button></div></section>
    <section class="landing-coach-section"><div class="coach-quote"><span class="landing-eyebrow">THE COACH IN THE LOOP</span><blockquote>“Good hands are a start.<br><em>Good decisions win points.</em>”</blockquote><p>Flyball turns every return into a piece of feedback: racket angle, preparation, placement, and pressure.</p></div><div class="coach-list"><div><span>↗</span><b>Pointer fallback</b><small>Start playing immediately with your mouse.</small></div><div><span>◉</span><b>Camera paddle</b><small>Use your webcam to make your hands the controller.</small></div><div><span>✦</span><b>Global rankings</b><small>Save your fundamentals and boss-run scores.</small></div></div></section>
    <section class="landing-leaderboard" id="leaderboard-preview"><div><span class="landing-eyebrow">THE ARENA / LIVE RANKINGS</span><h2>Train with a score to settle.</h2><p>Compete on fundamentals or see how long you can last against the fly.</p></div><button class="landing-outline" id="landing-leaderboard">View leaderboard <span>↗</span></button></section>
    <footer class="landing-footer"><span>flyball<span class="accent">.</span> / ping pong trainer</span><span>Made for better fundamentals.</span></footer>
  </section>
  <section class="mode-panel" id="mode-panel" aria-label="Choose training mode"><div class="mode-panel-inner"><div class="mode-choice" id="mode-choice"><span class="landing-eyebrow">WELCOME TO THE ARENA</span><h2>How do you want to train?</h2><p>Choose your lane. You can switch drills at any time from the top of the arena.</p><div class="mode-options"><button class="mode-option" data-mode="casual"><span class="mode-icon">◎</span><span><strong>Casual Drills</strong><small>Practice freely. Misses reset the rally, never the session.</small></span><span class="mode-arrow">→</span></button><button class="mode-option ranked" data-mode="ranked"><span class="mode-icon">✦</span><span><strong>Ranked Drills</strong><small>Put your fundamentals on the board and chase a personal best.</small></span><span class="mode-arrow">→</span></button></div></div><div class="landscape-choice hidden" id="landscape-choice"><span class="landing-eyebrow">SET THE SCENE</span><h2>Where do you want to play?</h2><p>Pick the atmosphere for this session. You can change it before your next drill.</p><div class="landscape-options"><button class="landscape-option selected" data-landscape="classic"><span class="landscape-preview classic-preview"></span><strong>Classic Arena</strong><small>Clean table, focused mind.</small></button><button class="landscape-option" data-landscape="sunset"><span class="landscape-preview sunset-preview"></span><strong>Sunset Court</strong><small>Warm light, loose hands.</small></button><button class="landscape-option" data-landscape="neon"><span class="landscape-preview neon-preview"></span><strong>Neon Night</strong><small>Pressure looks good on you.</small></button></div><button class="landscape-start" id="landscape-start">Enter the arena <span>→</span></button></div><button class="mode-back" id="mode-back">← Back to home</button></div></section>
  <header class="topbar"><button type="button" class="brand" id="topbar-brand" aria-label="Back to home"><span class="brand-emoji" aria-hidden="true">🏓</span><span>flyball<span class="accent">.</span></span></button><div class="session-pill"><span class="live-dot"></span><span id="session-status">READY</span></div><div class="drill-switcher"><button class="drill-arrow" id="previous-drill" aria-label="Previous drill">←</button><span id="active-drill">Rally builder</span><button class="drill-arrow" id="next-drill" aria-label="Next drill">→</button></div><button class="sidebar-toggle" id="sidebar-toggle"><span>☰</span> Coach</button><button class="text-button" id="landing-return">Home</button><button class="text-button" id="leaderboard-button">Leaderboard ↗</button></header>
  <div class="hud-grid"><div class="hud-card score-card"><span class="eyebrow">YOUR SCORE</span><strong id="score">0</strong><small><span id="rally">0</span> hit rally</small></div><div class="hud-card"><span class="eyebrow">BEST RALLY</span><strong id="best-rally">0</strong><small>clean returns</small></div><div class="hud-card"><span class="eyebrow">DRILL PROGRESS</span><strong id="accuracy">—</strong><small id="progress-label">returns / attempts</small></div><div class="hud-card boss-card"><span class="eyebrow">BOSS LEVEL</span><strong id="boss-level">01</strong><small id="difficulty-label">Standard drill</small></div></div>
  <div class="feedback" id="feedback">Choose a drill to begin.</div>
  <aside class="control-panel"><div><span class="eyebrow">COACHING PLAN</span><h1 id="panel-title">Build your fundamentals.</h1><p id="panel-copy">Pick a drill, then use your paddle to return the simulated ball.</p></div><div class="target-stage" id="target-stage"><div><span class="eyebrow">CURRENT MOVE</span><strong id="target-move">Ready to train</strong></div><span class="target-count" id="target-count">0 / 5</span><p id="target-cue">Every target move requires five clean repetitions before the next one unlocks.</p></div><div class="drill-list">${Object.entries(DRILLS).map(([key, value]) => `<button class="drill-option ${key === 'rally' ? 'selected' : ''}" data-drill="${key}"><span class="difficulty-icon">${key === 'fly' ? '✦' : key === 'target' ? '◎' : '↗'}</span><span><b>${value.label}</b><small>${value.detail}</small></span></button>`).join('')}</div><div class="difficulty-list">${Object.entries(DIFFICULTIES).map(([key, value]) => `<button class="difficulty-option ${key === 'standard' ? 'selected' : ''}" data-difficulty="${key}"><span><b>${value.label}</b><small>${value.detail}</small></span></button>`).join('')}</div><div class="control-actions"><button class="primary-button" id="start-button">Start drill →</button><button class="secondary-button" id="pause-button">Pause</button><button class="secondary-button" id="reset-button">Reset</button></div><div class="control-actions secondary-actions"><button class="secondary-button" id="machine-button">Pause ball machine</button><button class="secondary-button" id="cv-button">Use camera paddle</button></div><p class="control-hint">No VR required: move the on-screen paddle with your pointer, or enable camera CV. XR remains available when you have it.</p></aside>
  <div class="leaderboard-panel hidden" id="leaderboard-panel"><div class="panel-heading"><div><span class="eyebrow">THE ARENA / LIVE RANKINGS</span><h2>Fundamentals under pressure.</h2></div><button class="text-button" id="close-leaderboard">Close</button></div><div class="leader-tabs"><button class="leader-tab selected" data-category="fundamentals">Fundamentals</button><button class="leader-tab" data-category="boss">Boss survival</button></div><div id="leaderboard-list"></div></div>
  <div class="summary-panel hidden" id="summary-panel"><span class="eyebrow">SESSION COMPLETE</span><h2 id="summary-title">Good work.</h2><p id="summary-coach" class="summary-coach"></p><div class="summary-grid" id="summary-grid"></div><div class="save-row"><input id="player-name" maxlength="32" placeholder="your name" aria-label="Player name"/><button class="primary-button" id="save-score">Save score</button></div><p class="save-status" id="save-status"></p><button class="secondary-button" id="summary-close">Back to drills</button></div>`;
  document.body.appendChild(root);

  let difficulty = 'standard';
  let drill = 'rally';
  let category = 'fundamentals';
  let mode = 'casual';
  let landscape = 'classic';
  let pendingDrill = drill;
  let lastSummary = null;
  const $ = (id) => root.querySelector(`#${id}`);
  const enterTrainer = () => { root.classList.remove('landing-active', 'mode-select-active'); root.classList.add('sidebar-closed'); window.scrollTo(0, 0); };
  const showModeSelect = (nextDrill = drill) => { pendingDrill = nextDrill; root.classList.remove('landing-active'); root.classList.add('mode-select-active'); $('mode-choice').classList.remove('hidden'); $('landscape-choice').classList.add('hidden'); };
  const enterLanding = () => { root.classList.add('landing-active'); root.classList.remove('mode-select-active', 'sidebar-closed'); $('leaderboard-panel').classList.add('hidden'); $('summary-panel').classList.add('hidden'); };
  const startMode = (selectedMode) => { mode = selectedMode; $('mode-choice').classList.add('hidden'); $('landscape-choice').classList.remove('hidden'); onLandscapeChange?.(landscape); };
  const chooseDrill = (nextDrill) => {
    drill = nextDrill;
    root.querySelectorAll('[data-drill]').forEach((item) => item.classList.toggle('selected', item.dataset.drill === drill));
    $('panel-title').textContent = DRILLS[drill].label;
    $('panel-copy').textContent = DRILLS[drill].detail;
    $('active-drill').textContent = DRILLS[drill].label;
  };

  const update = (summary, status = 'TRAINING') => {
    if (!summary) return;
    $('score').textContent = summary.score;
    $('rally').textContent = summary.rally;
    $('best-rally').textContent = summary.longestRally;
    $('accuracy').textContent = drill === 'target' ? `${summary.targetAccuracy}%` : `${summary.accuracy}%`;
    $('progress-label').textContent = drill === 'target' ? `${summary.completedMoves}/${summary.totalMoves} moves · ${summary.targetHits} hits` : 'returns / attempts';
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
    const node = $('feedback'); node.textContent = message; node.className = `feedback ${kind}`; window.clearTimeout(feedback.timer); feedback.timer = window.setTimeout(() => node.className = 'feedback', 1800);
  };

  const showSummary = (summary) => {
    lastSummary = summary; update(summary, 'COMPLETE');
    $('summary-title').textContent = summary.drill === 'fly' ? 'You read the fly.' : summary.drill === 'target' ? (summary.targetComplete ? 'Target sequence complete.' : `${summary.completedMoves} moves completed.`) : 'You found your rhythm.';
    $('summary-coach').textContent = summary.drill === 'target' ? `${summary.completedMoves}/${summary.totalMoves} moves complete. ${summary.targetComplete ? 'Excellent control—repeat the sequence at the next speed.' : DRILLS.target.coach}` : summary.drill === 'fly' ? `${summary.flyReturns} fly returns and ${summary.flyMisses} fly misses. ${DRILLS.fly.coach}` : summary.accuracy >= 70 ? 'Good consistency. Next, reduce swing size and challenge the next speed.' : DRILLS[summary.drill].coach;
    $('summary-grid').innerHTML = [['Score', summary.score], ['Moves complete', `${summary.completedMoves}/${summary.totalMoves}`], ['Longest rally', `${summary.longestRally} hits`], ['Accuracy', `${summary.accuracy}%`], ['Target hits', `${summary.targetHits}`], ['Fly returns', `${summary.flyReturns ?? 0}`], ['Fly misses', `${summary.flyMisses ?? 0}`], ['Survival', `${summary.survivalSeconds}s`], ['Reaction', summary.reactionMs ? `${summary.reactionMs}ms` : '—']].map(([label, value]) => `<div><small>${label}</small><strong>${value}</strong></div>`).join('');
    $('summary-panel').classList.remove('hidden');
  };

  const loadLeaderboard = async () => {
    const list = $('leaderboard-list'); list.innerHTML = '<p class="muted">Loading rankings…</p>'; const rows = await getLeaderboard(category);
    list.innerHTML = rows.length ? rows.map((row, index) => `<div class="leader-row"><span class="rank">${String(index + 1).padStart(2, '0')}</span><span><b>${escapeHtml(row.player_name)}</b><small>${row.max_rally} hit rally · ${row.difficulty}</small></span><strong>${row.score.toLocaleString()} pts</strong></div>`).join('') : '<p class="muted">No scores yet. Be first.</p>';
  };

  root.querySelectorAll('[data-drill]').forEach((button) => button.addEventListener('click', () => { chooseDrill(button.dataset.drill); update({ drill, difficulty, completedMoves: 0, totalMoves: 6, targetHits: 0, targetAccuracy: 0, accuracy: 0, score: 0, rally: 0, longestRally: 0, bossLevel: DIFFICULTIES[difficulty].bossLevel, currentMoveNumber: 1, currentMoveLabel: 'Ready to train', currentMoveCue: DRILLS[drill].coach, moveSuccesses: 0, moveRequired: 5 }, 'READY'); }));
  root.querySelectorAll('[data-difficulty]').forEach((button) => button.addEventListener('click', () => { difficulty = button.dataset.difficulty; root.querySelectorAll('[data-difficulty]').forEach((item) => item.classList.toggle('selected', item === button)); }));
  root.querySelectorAll('[data-landing-drill]').forEach((button) => button.addEventListener('click', () => showModeSelect(button.dataset.landingDrill)));
  $('landing-start').addEventListener('click', () => showModeSelect());
  $('landing-nav-start').addEventListener('click', () => showModeSelect());
  $('landing-camera').addEventListener('click', () => showModeSelect());
  root.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => startMode(button.dataset.mode)));
  $('mode-back').addEventListener('click', enterLanding);
  root.querySelectorAll('[data-landscape]').forEach((button) => button.addEventListener('click', () => { landscape = button.dataset.landscape; root.querySelectorAll('[data-landscape]').forEach((item) => item.classList.toggle('selected', item === button)); onLandscapeChange?.(landscape); }));
  $('landscape-start').addEventListener('click', () => { chooseDrill(pendingDrill); enterTrainer(); onStart(difficulty, drill, mode, landscape); feedback(mode === 'ranked' ? 'Ranked drill live — make every return count.' : 'Casual drill live — build your rhythm.', 'success'); });
  $('sidebar-toggle').addEventListener('click', () => root.classList.toggle('sidebar-closed'));
  const switchDrill = (direction) => { const keys = Object.keys(DRILLS); const next = (keys.indexOf(drill) + direction + keys.length) % keys.length; chooseDrill(keys[next]); onDrillChange?.(drill, mode); feedback(`Switched to ${DRILLS[drill].label}.`, 'success'); };
  $('previous-drill').addEventListener('click', () => switchDrill(-1));
  $('next-drill').addEventListener('click', () => switchDrill(1));
  $('landing-return').addEventListener('click', enterLanding);
  $('topbar-brand').addEventListener('click', enterLanding);
  $('landing-leaderboard').addEventListener('click', () => { enterTrainer(); $('leaderboard-panel').classList.remove('hidden'); loadLeaderboard(); });
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
    try { const result = await submitScore(name, lastSummary, category); $('save-status').textContent = result.storage === 'local' ? `Saved on this device. Configure Supabase to publish globally. (${scoreFor(lastSummary, category)} pts)` : 'Score saved to the arena.'; } catch { $('save-status').textContent = 'Could not reach the leaderboard. Your session is still safe.'; }
  });

  return { update, feedback, showSummary, getDifficulty: () => difficulty, getDrill: () => drill, isModeSelecting: () => root.classList.contains('mode-select-active') };
}
